//! Settling an order's money -- paid directly (`dispatch_types::direct`).
//!
//! Each party settles their own: the store makes its decisions about an
//! order on schedule (`issues::decide_order`), from its own conductor; and
//! each payee's app captures what it's owed on its own processor, once
//! nothing about it can change (`settlement_due`). What it's owed is worked
//! out by the same functions validation checks it with
//! (`dispatch_integrity::basis`), so a settlement the app proposes is one
//! the network accepts.

use crate::stores::my_stores;
use dispatch_integrity::basis::{basis_of, chain_check, part_bid};
use dispatch_integrity::direct::{entitlement, part_share, Entitlement, Part, PaymentLeg};
use dispatch_integrity::*;
use handshake_coordinator_support::chain::mine;
use handshake_coordinator_support::{decode_or, guest, original_action_of};
use hdk::prelude::*;

// --- what's known about an order, for settling it ---

/// A driver leaving before pickup.
struct Release {
    version: ActionHash,
    bid: ActionHash,
    /// They'd committed and the store had started cooking: they answer for
    /// the food until another driver is confirmed.
    liable: bool,
}

/// What's happened to an order, as its settling turns on it.
struct Facts {
    /// The store's decisions (see `issues`).
    decisions: crate::issues::Decisions,
    /// Every version that cancels it, across every branch of its history.
    cancellations: Vec<ActionHash>,
    releases: Vec<Release>,
    /// The store confirming a later driver: the version, and each bid that
    /// left before it, now clear.
    replaced: Vec<(ActionHash, ActionHash)>,
    /// Whether the order is over: collected, cancelled, or its store's
    /// decided whether it arrived.
    finished: bool,
    /// Whether the customer had it -- the store then settles the food once
    /// their report window runs out.
    received: bool,
}

impl Facts {
    /// Every record a capture could rest on: the store's decisions, then
    /// each cancellation, release and replacement.
    fn bases(&self) -> Vec<ActionHash> {
        let d = &self.decisions;
        let mut out: Vec<ActionHash> = [d.settlement.as_ref().map(|(h, _)| h), d.delivered.as_ref().map(|(h, _)| h), d.not_delivered.as_ref().map(|(h, _)| h)].into_iter().flatten().cloned().collect();
        out.extend(self.cancellations.iter().cloned());
        out.extend(self.releases.iter().map(|r| r.version.clone()));
        out.extend(self.replaced.iter().map(|(version, _)| version.clone()));
        out
    }
}

/// Every version of an order, original first then each update, across any
/// branches.
fn versions(order: &ActionHash) -> ExternResult<Vec<Record>> {
    let mut out = Vec::new();
    let mut frontier = vec![order.clone()];
    while let Some(hash) = frontier.pop() {
        let Some(Details::Record(details)) = get_details(hash, GetOptions::default())? else { continue };
        frontier.extend(details.updates.iter().map(|u| u.action_address().clone()));
        out.push(details.record);
    }
    Ok(out)
}

fn facts(order: &ActionHash) -> ExternResult<Option<Facts>> {
    let all = versions(order)?;
    let Some(original) = all.first() else { return Ok(None) };
    let delivery = decode_or::<DeliveryOrder>(original).is_some();
    let mut facts = Facts { decisions: crate::issues::decisions_of(order)?, cancellations: Vec::new(), releases: Vec::new(), replaced: Vec::new(), finished: false, received: false };
    let mut delivered = false;
    let prior_of = |record: &Record| match &record.action().data {
        ActionData::Update(update) => all.iter().find(|r| r.action_address() == &update.original_action_address),
        _ => None,
    };
    for record in &all {
        let prior = prior_of(record);
        if !delivery {
            let Some(o) = decode_or::<PickupOrder>(record) else { continue };
            facts.finished |= o.status.is_terminal();
            facts.received |= o.status == PickupStatus::PickedUp;
            let was_cancelled = prior.and_then(decode_or::<PickupOrder>).is_some_and(|p| p.cancellation.is_some());
            if o.cancellation.is_some() && prior.is_some() && !was_cancelled {
                facts.cancellations.push(record.action_address().clone());
            }
            continue;
        }
        let (Some(version), Some(prior)) = (lineage::Version::of(record.clone()), prior.and_then(|p| lineage::Version::of(p.clone()))) else { continue };
        facts.finished |= version.order.status.is_terminal();
        facts.received |= matches!(version.order.status, DeliveryStatus::Delivered | DeliveryStatus::Collected);
        delivered |= version.order.status == DeliveryStatus::Delivered;
        if let Some(bid) = version.released(&prior) {
            facts.releases.push(Release { version: record.action_address().clone(), liable: version.released_liable(&prior).is_some(), bid });
        }
        let collecting = version.order.status == DeliveryStatus::Collecting && prior.order.status != DeliveryStatus::Collecting;
        if lineage::confirms_driver(&version, &prior) || collecting {
            let confirmed = version.order.accepted_bid.clone();
            lineage::find_back(version.clone(), |v, p| {
                if let Some(bid) = p.and_then(|p| v.released(p)).filter(|bid| Some(bid) != confirmed.as_ref()) {
                    facts.replaced.push((record.action_address().clone(), bid));
                }
                None::<()>
            })?;
        }
        if version.order.cancellation.is_some() && prior.order.status != DeliveryStatus::Cancelled {
            facts.cancellations.push(record.action_address().clone());
        }
    }
    // A delivery that reached its customer, or that they said never did,
    // is over once its store has decided which: what the driver's paid or
    // forfeits rests on that decision, and a hold settles only once --
    // settled before the decision's seen, it would settle for nothing.
    let decided = facts.decisions.delivered.is_some() || facts.decisions.not_delivered.is_some();
    facts.finished = decided || (facts.finished && !delivered);
    Ok(Some(facts))
}

// --- what a payee is owed ---

/// How long the store waits for a driver to settle their pay before it
/// settles the customer's payment without passing that pay on: by then the
/// driver's own authorization is days from lapsing anyway.
const PASS_ON_WAIT_MICROS: i64 = 4 * 86_400_000_000;

/// One part of a settlement the caller can make, and what it takes.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct DueClaim {
    pub claim: Claim,
    pub amount: u64,
}

/// A payment record on an order, with its author.
fn payment_records(order: &ActionHash) -> ExternResult<Vec<Record>> {
    let mut out = Vec::new();
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToPayment)?, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(hash, GetOptions::default())? {
            out.push(record);
        }
    }
    Ok(out)
}

/// The holds on `order`, by leg, each with its hash and author.
pub(crate) fn holds_on(order: &ActionHash) -> ExternResult<Vec<(ActionHash, AgentPubKey, PaymentHold, PaymentOffer)>> {
    let mut out = Vec::new();
    for record in payment_records(order)? {
        let Some(hold) = decode_or::<PaymentHold>(&record) else { continue };
        let Some(offer) = get(hold.offer.clone(), GetOptions::default())?.and_then(|r| decode_or::<PaymentOffer>(&r)) else { continue };
        if &offer.order == order {
            out.push((record.action_address().clone(), record.action().author().clone(), hold, offer));
        }
    }
    Ok(out)
}

/// The settlements on `order`, each with its hash and author.
pub(crate) fn settlements_on(order: &ActionHash) -> ExternResult<Vec<(ActionHash, AgentPubKey, PaymentSettlement)>> {
    Ok(payment_records(order)?
        .into_iter()
        .filter_map(|record| decode_or::<PaymentSettlement>(&record).map(|s| (record.action_address().clone(), record.action().author().clone(), s)))
        .collect())
}

/// The order's terms, its store, and whether it's a delivery.
fn order_terms(order: &ActionHash) -> ExternResult<Option<OrderTerms>> {
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    Ok(decode_or::<DeliveryOrder>(&record).map(|o| OrderTerms::of_delivery(&o)).or_else(|| decode_or::<PickupOrder>(&record).map(|o| OrderTerms::of_pickup(&o))))
}

fn bid_of(bid: &ActionHash) -> ExternResult<Option<Bid>> {
    Ok(get(bid.clone(), GetOptions::default())?.and_then(|r| decode_or::<Bid>(&r)))
}

/// The parts a leg's payee captures on their own entitlement -- every
/// part of the leg but a driver's pay the store passes on.
fn own_parts(leg: &PaymentLeg) -> Vec<Part> {
    let part = |purpose: HoldPurpose, portion: Portion| Part { purpose, portion };
    match leg {
        PaymentLeg::Customer => vec![part(HoldPurpose::Food, Portion::Food)],
        PaymentLeg::DriverPay { bid } => vec![
            part(HoldPurpose::DriverPay { bid: bid.clone() }, Portion::Fee),
            part(HoldPurpose::DriverPay { bid: bid.clone() }, Portion::Tip),
            part(HoldPurpose::Subsidy { bid: bid.clone() }, Portion::Fee),
            part(HoldPurpose::Subsidy { bid: bid.clone() }, Portion::LateCover),
        ],
        PaymentLeg::Collateral { bid } => vec![part(HoldPurpose::Collateral { bid: bid.clone() }, Portion::Collateral)],
    }
}

/// Whether nothing more can change what a leg's payee is owed.
fn settled_enough(leg: &PaymentLeg, facts: &Facts) -> bool {
    match leg {
        // The food is the store's once it's settled -- or, never received,
        // once the order's over.
        PaymentLeg::Customer => facts.finished && (facts.decisions.settlement.is_some() || !facts.received),
        // A driver's pay is decided by their delivery, leaving, or the
        // order's end.
        PaymentLeg::DriverPay { bid } => facts.finished || facts.releases.iter().any(|r| &r.bid == bid) || facts.replaced.iter().any(|(_, b)| b == bid),
        // Collateral answers for the food until the driver's replaced, or
        // left without answering for it, or the order's over.
        PaymentLeg::Collateral { bid } => facts.finished || facts.replaced.iter().any(|(_, b)| b == bid) || facts.releases.iter().any(|r| &r.bid == bid && !r.liable),
    }
}

/// What the caller's hold `hold_ref` settles with, once nothing can change
/// it: the claims to capture, each with what it takes (none: release it
/// all). `None` while it might still change -- or if it isn't the caller's.
pub(crate) fn settlement_due(hold_ref: &ActionHash) -> ExternResult<Option<Vec<DueClaim>>> {
    let me = agent_info()?.agent_initial_pubkey;
    let Some(record) = get(hold_ref.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(hold) = decode_or::<PaymentHold>(&record) else { return Ok(None) };
    if record.action().author() != &me {
        return Ok(None);
    }
    let Some(offer) = get(hold.offer.clone(), GetOptions::default())?.and_then(|r| decode_or::<PaymentOffer>(&r)) else { return Ok(None) };
    let order = offer.order;
    let (Some(facts), Some(terms)) = (facts(&order)?, order_terms(&order)?) else { return Ok(None) };
    if !settled_enough(&offer.leg, &facts) {
        return Ok(None);
    }
    let chain_top = agent_info()?.chain_head.0;
    let bases = facts.bases();
    let mut due = Vec::new();
    for part in own_parts(&offer.leg) {
        let bid = match part_bid(&part) {
            Some(bid_ref) => bid_of(bid_ref)?,
            None => None,
        };
        let Some((_, amount)) = part_share(&terms, &part, bid.as_ref()) else { continue };
        for basis_ref in &bases {
            let Ok(basis) = basis_of(basis_ref, &order, &terms.merchant, terms.delivery, &part)? else { continue };
            let taken = match entitlement(&part, amount, &basis) {
                Entitlement::Takes(n) => Some(n),
                Entitlement::TakesIf(check, n) if chain_check(check, basis_ref, &order, &part, &me, &chain_top)? => Some(n),
                _ => None,
            };
            if let Some(amount) = taken {
                due.push(DueClaim { claim: Claim { part: part.clone(), basis: basis_ref.clone(), via: None }, amount });
                break;
            }
        }
    }
    // The store passes on to each driver exactly what they took of the
    // customer's share and tip -- once they've settled, or once it's waited
    // long enough for them.
    if offer.leg == PaymentLeg::Customer && terms.delivery {
        let settlements = settlements_on(&order)?;
        let mut waiting = false;
        for (driver_hold, driver, _, driver_offer) in holds_on(&order)? {
            let PaymentLeg::DriverPay { bid } = &driver_offer.leg else { continue };
            let Some(bid_record) = bid_of(bid)? else { continue };
            if driver != bid_record.bidder {
                continue;
            }
            match settlements.iter().find(|(_, author, s)| author == &driver && s.hold == driver_hold) {
                Some((settled, _, theirs)) => {
                    for claim in theirs.claims.iter().filter(|c| matches!(c.part.purpose, HoldPurpose::DriverPay { .. })) {
                        let Some((_, amount)) = part_share(&terms, &claim.part, Some(&bid_record)) else { continue };
                        due.push(DueClaim { claim: Claim { part: claim.part.clone(), basis: claim.basis.clone(), via: Some(settled.clone()) }, amount });
                    }
                }
                None => waiting = true,
            }
        }
        let held_at = record.action().timestamp().as_micros();
        if waiting && sys_time()?.as_micros() < held_at + PASS_ON_WAIT_MICROS {
            return Ok(None);
        }
    }
    Ok(Some(due))
}

/// Has the store's conductor make its decisions on one order (its original
/// action) -- for a screen that's just seen it change. Returns how many it
/// made (0 or 1).
#[hdk_extern]
pub fn settle_order(order_original_action: ActionHash) -> ExternResult<u32> {
    let order = original_action_of(order_original_action)?;
    Ok(u32::from(crate::issues::decide_as_store(&order)))
}

// --- the sweep ---

/// Orders the caller has a part in, from the last `days`.
pub(crate) struct Candidates {
    /// Those they placed, bid on, or received at one of their stores, by
    /// their original actions.
    pub orders: Vec<ActionHash>,
    /// Orders they bid on whose original couldn't be worked out this time
    /// -- as the bid names them, with why. Never left out unsaid: the
    /// driver's own payments ride on them.
    pub unreadable: Vec<(ActionHash, String)>,
}

impl Candidates {
    /// Every order, or an error if any can't be told -- for a count that
    /// must miss none.
    pub fn all(self) -> ExternResult<Vec<ActionHash>> {
        match self.unreadable.into_iter().next() {
            Some((order, reason)) => Err(guest(format!("order {order} can't be read yet: {reason}"))),
            None => Ok(self.orders),
        }
    }
}

pub(crate) fn candidates(days: i64) -> ExternResult<Candidates> {
    let since = Timestamp::from_micros(sys_time()?.as_micros() - days * 86_400_000_000);
    let types = [EntryType::try_from(UnitEntryTypes::DeliveryOrder)?, EntryType::try_from(UnitEntryTypes::PickupOrder)?, EntryType::try_from(UnitEntryTypes::Bid)?];
    let mut orders: Vec<ActionHash> = Vec::new();
    let mut unreadable = Vec::new();
    for record in mine(&types).since(since).records()? {
        match decode_or::<Bid>(&record) {
            Some(bid) => match original_action_of(bid.order_ref.clone()) {
                Ok(order) => orders.push(order),
                Err(err) => unreadable.push((bid.order_ref, err.to_string())),
            },
            None if matches!(record.action().data, ActionData::Create(_)) => orders.push(record.action_address().clone()),
            None => {}
        }
    }
    let today = history_day(sys_time()?);
    for store in my_stores()? {
        let owner = QueueOwner::Store(&store);
        for day in (today - days)..=today {
            orders.extend(owner.orders_on_day(day)?);
        }
    }
    orders.sort();
    orders.dedup();
    unreadable.sort();
    unreadable.dedup_by(|a, b| a.0 == b.0);
    Ok(Candidates { orders, unreadable })
}

/// Has the store make its decisions on every recent order of the caller's
/// (and the customer's app confirm what it's seen of theirs); returns how
/// many decisions it made. Each in a zome call of its own: a write that
/// doesn't validate yet (its basis still gossiping here) fails only that
/// order's call, never the rest of the sweep.
fn sweep(days: i64) -> u32 {
    let _ = crate::confirmations::tend_confirmations();
    let mut decided = 0;
    // The sweep runs again on its schedule: an order it can't read now is
    // decided then.
    let orders = candidates(days).map(|c| c.orders).unwrap_or_default();
    for order in orders {
        decided += handshake_coordinator_support::isolated::<_, u32>("settle_order", order.clone()).unwrap_or(0);
    }
    decided
}

use crate::order_queues::QueueOwnerExt;


/// The window a regular sweep covers. A store's decision can come later
/// than this; its signal triggers a longer sweep (`settle_soon`).
const SWEEP_DAYS: i64 = 2;
const SIGNALLED_SWEEP_DAYS: i64 = 30;

/// Whether this device's account has moved on to a new key -- an old
/// device turning up after its owner recovered (docs/RECOVERY.md). Its
/// stores have moved with it, so its sweeps skip -- but stay scheduled: a
/// recovery the owner voids (by replacing the plan it rested on, if it
/// wasn't theirs) moves the account back here, and its sweeps carry on.
/// Whether this device's account has moved on -- or is being handed to a
/// new phone right now: either way, it settles nothing of its own accord.
/// One that can't tell just now holds off too: everything this gates runs
/// again on its schedule, while acting would write for an account that may
/// be someone else's now.
pub(crate) fn moved_on() -> bool {
    handshake_coordinator_support::handing_over() || agent_info().and_then(|info| crate::accounts::has_moved(&info.agent_initial_pubkey)).unwrap_or(true)
}

/// Every five minutes, for as long as the conductor runs: the store's
/// decisions are made without anyone having the app open. Scheduled at
/// `init`.
#[hdk_extern(infallible)]
pub fn settle_periodically(_: Option<Schedule>) -> Option<Schedule> {
    if !moved_on() {
        let _ = sweep(SWEEP_DAYS);
    }
    Some(Schedule::Persisted(SWEEP_CRON.into()))
}

/// Seconds, minutes, hours, day, month, weekday, year.
const SWEEP_CRON: &str = "0 */5 * * * * *";

const FIRST_RETRY: core::time::Duration = core::time::Duration::from_secs(5);
const LAST_RETRY: core::time::Duration = core::time::Duration::from_secs(160);

/// Scheduled when one of the caller's orders changes (its signal). The
/// change may not have reached the caller yet, so this retries with backoff
/// -- and progress restarts the backoff, as signals that arrive meanwhile
/// share this one schedule: a burst of orders is followed until it's quiet.
/// The regular sweep covers anything later.
#[hdk_extern(infallible)]
pub fn settle_soon(previous: Option<Schedule>) -> Option<Schedule> {
    // Ends this burst; the regular sweep checks again every five minutes.
    if moved_on() {
        return None;
    }
    let settled = sweep(SIGNALLED_SWEEP_DAYS) > 0;
    let next = match previous {
        Some(Schedule::Ephemeral(after)) if !settled => after * 2,
        _ => FIRST_RETRY,
    };
    (next <= LAST_RETRY).then_some(Schedule::Ephemeral(next))
}
