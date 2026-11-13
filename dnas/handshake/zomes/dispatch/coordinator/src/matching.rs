//! How drivers find work: every open order is indexed under its store's
//! geohash cell -- the restaurant's, where a driver goes first, as the big
//! delivery apps offer orders to drivers near it -- and a time bucket, so a
//! read is bounded by recent orders, never all of history. A driver who's
//! online reads the cells around them (`get_open_orders_near`).
//!
//! Drivers pull; they never announce where they are. Anything a driver
//! published -- a presence beacon, say -- would be signed with their key,
//! and anyone could follow them through a shift (and home at the end of it).
//! So the only trace a driver's location leaves is a read of a public list,
//! seen only by whichever peer happens to store that list.

use dispatch_integrity::{open_order_anchor, LinkTypes, OPEN_ORDER_BUCKET_MILLIS};
use hdi::hash_path::path::Path;
use hdk::prelude::*;
use handshake_coordinator_support::{call_local, decode_or, get_links_many, guest, original_action_of, originals_of, resolve_latest, resolve_many};

pub(crate) fn open_order_anchor_path(geohash: &str, bucket: i64) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(open_order_anchor(geohash, bucket)).typed(LinkTypes::OpenOrderGeohashAnchor)
}

/// Open orders in `geohash` and its neighbouring cells -- what an online
/// driver's app reads every few seconds. The oldest first, up to the
/// network's `max_listed_orders`: an area however busy costs each read the
/// same, and an order never waits behind newer ones -- each is listed in
/// turn as those before it are taken.
#[hdk_extern]
pub fn get_open_orders_near(geohash: String) -> ExternResult<Vec<Record>> {
    use dispatch_integrity::DeliveryOrder;
    use dispatch_integrity::DeliveryStatus;

    let now = sys_time()?;
    let current_bucket = handshake_types::time_bucket(now.as_millis(), OPEN_ORDER_BUCKET_MILLIS);
    // Each cell's anchor in the current bucket and the one before: an order
    // published just before the bucket turned is still in the last.
    let mut queries = Vec::new();
    for cell in handshake_types::cell_and_neighbors(&geohash) {
        for bucket in [current_bucket, current_bucket - 1] {
            let Ok(anchor) = open_order_anchor_path(&cell, bucket)?.path_entry_hash() else { continue };
            queries.push(LinkQuery::try_new(anchor, LinkTypes::OpenOrderGeohashAnchor)?);
        }
    }
    // Anchor links point at the store's acceptance (the version that opened
    // the order); each order is read at its current version, so one that's
    // moved on stops showing as Open. Oldest first, a batch at a time --
    // each batch's originals and current versions read together -- until
    // the feed's full: what's read is bounded by the feed, not the area.
    let mut links = get_links_many(queries)?.into_iter().flatten().collect::<Vec<_>>();
    links.sort_by_key(|link| link.timestamp);
    let mut listed = std::collections::BTreeSet::new();
    let opened: Vec<ActionHash> = links.into_iter().filter_map(|link| link.target.into_action_hash()).filter(|target| listed.insert(target.clone())).collect();
    let most = handshake_governance::max_listed_orders() as usize;
    let mut seen = std::collections::BTreeSet::new();
    let mut orders = Vec::new();
    for batch in opened.chunks(most) {
        let originals: Vec<ActionHash> = originals_of(batch)?.into_iter().flatten().filter(|o| seen.insert(o.clone())).collect();
        orders.extend(resolve_many(&originals)?.into_iter().flatten().filter(|record| decode_or::<DeliveryOrder>(record).is_some_and(|order| order.status == DeliveryStatus::Open)));
        if orders.len() >= most {
            break;
        }
    }
    orders.truncate(most);
    // Blocks (docs/REPUTATION.md, phase 4) aren't read here: this is polled
    // every few seconds, so the driver's app filters it from its own cache of
    // pairs, and `submit_bid` refuses a blocked pair whatever it shows.
    Ok(orders)
}

// --- matching a customer's order automatically ---

/// Every driver starts as if they'd made this many deliveries without
/// dropping one: a drop among their first few orders weighs on them, not
/// against them as if it were all they'd ever done.
pub const CLEAN_START: u64 = 5;

/// What the matching rule counts a bid as, with its working -- what
/// customers' and drivers' screens show, so nobody has to take the ranking
/// on trust.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default)]
pub struct BidWeight {
    /// In minor units: lowest wins. The fee, plus `time_cost`, plus
    /// `reliability_cost`.
    pub cost: u64,
    /// Its minutes to the customer, each at the network's
    /// `minute_value_cents`.
    pub time_cost: u64,
    /// Its fee again, in the share of the orders its driver took on that
    /// they dropped or let lapse -- counting `CLEAN_START` clean ones.
    pub reliability_cost: u64,
    /// Those orders: dropped or lapsed, and taken on in all.
    pub failed: u32,
    pub taken_on: u32,
}

/// The published rule (`rank_bids`), for one bid: `fee` arriving in
/// `eta_seconds`, by a driver with `record`, each minute worth
/// `minute_value` (`handshake_governance::minute_value_cents`).
fn weigh(fee: u64, eta_seconds: u32, record: &DriverRecord, minute_value: u64) -> BidWeight {
    let failed = record.dropped_count.saturating_add(record.lapsed_count);
    let taken_on = record.completed_count.saturating_add(failed);
    let reliability_cost = fee.saturating_mul(u64::from(failed)) / (u64::from(taken_on) + CLEAN_START);
    let time_cost = u64::from(eta_seconds).div_ceil(60).saturating_mul(minute_value);
    BidWeight { cost: fee.saturating_add(time_cost).saturating_add(reliability_cost), time_cost, reliability_cost, failed, taken_on }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct WeighMyBidInput {
    pub fee: u64,
    pub eta_seconds: u32,
}

/// How a bid the caller is about to make would count, on their record now
/// -- for their bid sheet.
#[hdk_extern]
pub fn weigh_my_bid(input: WeighMyBidInput) -> ExternResult<BidWeight> {
    Ok(weigh(input.fee, input.eta_seconds, &driver_record(&agent_info()?.agent_initial_pubkey)?, handshake_governance::minute_value_cents()))
}

/// One bid as the matching rule weighs it, best first in `rank_bids`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RankedBid {
    pub bid: ActionHash,
    pub weight: BidWeight,
    /// Why it can't be chosen now, if it can't.
    pub unavailable: Option<String>,
}

/// The bids on an order, as its app would choose among them, best first:
/// the network's published rule, the same for everyone --
///
/// > its price, plus each minute until the driver would hand it over at
/// > the network's `minute_value_cents`, plus its price again in the share
/// > of the orders they took on that they dropped or let lapse -- every
/// > driver starting with `CLEAN_START` clean ones
///
/// -- so a faster driver can win at a higher price, and a driver who
/// drops orders has to bid lower to win, without one early drop sinking a
/// new driver. Ties go to the earlier bid. A bid
/// over the customer's cap, from a driver who left this order, or from one
/// who can't take it on now is listed but can't be chosen.
#[hdk_extern]
pub fn rank_bids(order_ref: ActionHash) -> ExternResult<Vec<RankedBid>> {
    let order_ref = original_action_of(order_ref)?;
    let latest = resolve_latest(order_ref.clone())?;
    let order = decode_or::<dispatch_integrity::DeliveryOrder>(&latest).ok_or(guest("not a delivery"))?;
    Ok(ranked(&order_ref, &latest, &order)?.into_iter().map(|(ranked, _)| ranked).collect())
}

/// The ranking, with when each bid was placed.
fn ranked(order_ref: &ActionHash, latest: &Record, order: &dispatch_integrity::DeliveryOrder) -> ExternResult<Vec<(RankedBid, Timestamp)>> {
    use dispatch_integrity::{lineage, Bid, BidStatus};
    // Drivers who've left this order already.
    let left: Vec<ActionHash> = {
        let mut left = Vec::new();
        if let Some(version) = lineage::Version::of(latest.clone()) {
            lineage::find_back(version, |v, p| {
                if let Some(bid) = p.and_then(|p| v.released(p)) {
                    left.push(bid);
                }
                None::<()>
            })?;
        }
        left
    };
    let max = handshake_governance::max_concurrent_deliveries();
    let mut ranked = Vec::new();
    // The earliest bids, up to the network's limit: a flood of later ones
    // costs nothing to weigh.
    let mut links = get_links(LinkQuery::try_new(order_ref.clone(), LinkTypes::OrderToBid)?, GetStrategy::default())?;
    links.sort_by_key(|link| link.timestamp);
    links.truncate(handshake_governance::max_ranked_bids() as usize);
    let mut open = Vec::new();
    for link in links {
        let Some(bid_ref) = link.target.clone().into_action_hash() else { continue };
        let Ok(record) = resolve_latest(bid_ref.clone()) else { continue };
        let Some(bid) = decode_or::<Bid>(&record) else { continue };
        if bid.status != BidStatus::Open || original_action_of(bid.order_ref.clone()).ok().as_ref() != Some(order_ref) || record.action().author() != &bid.bidder {
            continue;
        }
        open.push((link, bid_ref, bid));
    }
    // A driver blocked with the customer or the store, either way, isn't
    // shown or matched (docs/REPUTATION.md, phase 4) -- read together.
    use crate::blocks::Party;
    let pairs = open.iter().flat_map(|(_, _, bid)| [(Party::Person(order.requester.clone()), Party::Person(bid.bidder.clone())), (Party::Store(order.catalog_ref.clone()), Party::Person(bid.bidder.clone()))]).collect();
    let blocked = crate::blocks::blocked_each(pairs)?;
    for ((link, bid_ref, bid), pair) in open.into_iter().zip(blocked.chunks(2)) {
        if pair.contains(&true) {
            continue;
        }
        let weight = weigh(bid.price_offer, bid.eta_seconds, &driver_record(&bid.bidder)?, handshake_governance::minute_value_cents());
        let unavailable = if order.max_delivery_fee.is_some_and(|cap| bid.price_offer > cap) {
            Some("Over your delivery fee limit.".to_string())
        } else if !crate::verification::bid_verification_stands(&bid)? {
            Some("This driver's verification has been withdrawn.".to_string())
        } else if left.contains(&bid_ref) {
            Some("This driver left your order.".to_string())
        } else if crate::order_queues::get_driver_load(bid.bidder.clone())?.taking(order.priority, max).is_err() {
            Some("This driver can't take another order right now.".to_string())
        } else {
            None
        };
        ranked.push((RankedBid { bid: bid_ref, weight, unavailable }, link.timestamp));
    }
    ranked.sort_by(|(a, at), (b, bt)| (a.unavailable.is_some(), a.weight.cost, *at, &a.bid).cmp(&(b.unavailable.is_some(), b.weight.cost, *bt, &b.bid)));
    Ok(ranked)
}

/// Mirrors the counts of `reputation::ReputationSummary` this rule reads.
#[derive(Deserialize, Debug, Default)]
struct DriverRecord {
    completed_count: u32,
    dropped_count: u32,
    #[serde(default)]
    lapsed_count: u32,
}

#[derive(Serialize, Debug)]
enum ReputationTargetWire {
    Driver(AgentPubKey),
}

fn driver_record(driver: &AgentPubKey) -> ExternResult<DriverRecord> {
    Ok(call_local("reputation", "get_reputation_summary", ReputationTargetWire::Driver(driver.clone()))?.unwrap_or_default())
}

/// For a customer's order set to match automatically: once the bid window
/// has run from its first bid, accepts the best available one. Returns
/// when it should look again, if it should.
pub(crate) fn auto_match(order_ref: &ActionHash, order: &dispatch_integrity::DeliveryOrder, now: i64) -> ExternResult<Option<Timestamp>> {
    let latest = resolve_latest(order_ref.clone())?;
    // Past the network's limit on driver changes, only its customer can
    // decide what happens next.
    if let Some(version) = dispatch_integrity::lineage::Version::of(latest.clone()) {
        if !dispatch_integrity::lineage::driver_changes(&version)?.allow_another() {
            return Ok(None);
        }
    }
    let ranked = ranked(order_ref, &latest, order)?;
    let Some(first) = ranked.iter().map(|(_, at)| *at).min() else { return Ok(None) };
    let closes = first.as_micros().saturating_add(handshake_governance::bid_window().as_micros() as i64);
    if now < closes {
        return Ok(Some(Timestamp::from_micros(closes)));
    }
    let Some((best, _)) = ranked.into_iter().find(|(r, _)| r.unavailable.is_none()) else { return Ok(None) };
    // In a call of its own. If it's refused (the driver has a warrant, say),
    // the next bid to arrive brings the app back.
    let accept = crate::bids::AcceptBidInput { order_original_action: order_ref.clone(), bid_action: best.bid, override_warrants: false };
    call(CallTargetCell::Local, zome_info()?.name, "accept_bid".into(), None, accept)?;
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECORD: DriverRecord = DriverRecord { completed_count: 0, dropped_count: 0, lapsed_count: 0 };
    const MINUTE: u64 = 10;

    #[test]
    fn a_clean_record_counts_a_bid_at_its_fee_and_time() {
        let weight = weigh(600, 12 * 60, &DriverRecord { completed_count: 40, ..RECORD }, MINUTE);
        assert_eq!((weight.time_cost, weight.reliability_cost, weight.cost), (120, 0, 720));
    }

    #[test]
    fn every_driver_starts_with_clean_deliveries() {
        // One drop, all they've done: a sixth of their fee, not all of it.
        let first = weigh(600, 0, &DriverRecord { dropped_count: 1, ..RECORD }, MINUTE);
        assert_eq!(first.reliability_cost, 100);
        // One in ten, over time: a fifteenth.
        let later = weigh(600, 0, &DriverRecord { completed_count: 9, dropped_count: 1, ..RECORD }, MINUTE);
        assert_eq!((later.failed, later.taken_on, later.reliability_cost), (1, 10, 40));
        // Lapsed offers count with drops.
        let lapsed = weigh(600, 0, &DriverRecord { completed_count: 9, lapsed_count: 1, ..RECORD }, MINUTE);
        assert_eq!(lapsed.reliability_cost, 40);
    }

    #[test]
    fn a_faster_driver_can_win_at_a_higher_fee() {
        let quick = weigh(700, 10 * 60, &RECORD, MINUTE);
        let slow = weigh(600, 25 * 60, &RECORD, MINUTE);
        assert!(quick.cost < slow.cost, "{quick:?} against {slow:?}");
    }
}
