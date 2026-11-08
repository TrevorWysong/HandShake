//! How many orders a driver carries at once: no more than the network
//! allows, and a priority order alone (`InHand`). Counted on the driver's own
//! chain -- each order they commit to is taken into their hands, and each
//! `CarryEnded` they record lets one go -- so a driver's commit is refused,
//! by everyone's validation, while their hands are full.
//!
//! A driver's app records an order leaving their hands as soon as it sees
//! it (`deliveries::end_carries`): its only effect is to free them to take
//! another, so they've every reason to.

use super::*;
use dispatch_types::lineage::{self, Version};
use dispatch_types::{CarryEnded, CarryRefusal, InHand};
use handshake_integrity_support::chain::{activity_since, creates_one_of, entry_of};
use handshake_integrity_support::{decode, original_creation};

/// How far back a driver's hands are counted: nobody carries an order for
/// two days, so an order whose end its driver never recorded stops
/// counting by then.
const CARRY_WINDOW_MICROS: i64 = 2 * 86_400_000_000;

/// Whether `record` is `driver`'s update committing to its order.
fn is_commit(record: &Record, driver: &AgentPubKey) -> bool {
    record.action().author() == driver && matches!(record.action().data, ActionData::Update(_)) && decode::<DeliveryOrder>(record).is_some_and(|o| o.status == DeliveryStatus::DriverEnRouteToMerchant)
}

/// What `driver` has in hand, by their own chain from `chain_top` back
/// over the carrying window.
pub fn in_hand(driver: &AgentPubKey, chain_top: &ActionHash) -> ExternResult<InHand> {
    let top = must_get_action(chain_top.clone())?.hashed.content.timestamp();
    let since = Timestamp::from_micros(top.as_micros() - CARRY_WINDOW_MICROS);
    let order_type: ScopedEntryDefIndex = UnitEntryTypes::DeliveryOrder.try_into()?;
    let ended_type: ScopedEntryDefIndex = UnitEntryTypes::CarryEnded.try_into()?;
    let mut commits: Vec<(ActionHash, bool)> = Vec::new();
    let mut ended: Vec<ActionHash> = Vec::new();
    for item in activity_since(driver, chain_top, since)? {
        let action = &item.action.hashed.content;
        let Some(entry_hash) = action.entry_hash() else { continue };
        if creates_one_of(action, &[ended_type]) {
            if let Entry::App(bytes) = entry_of(&item, entry_hash)? {
                ended.extend(CarryEnded::try_from(SerializedBytes::from(bytes)).ok().map(|c| c.committed));
            }
            continue;
        }
        let is_order_update = matches!(&action.data, ActionData::Update(u) if matches!(&u.entry_type, EntryType::App(def) if def.zome_index == order_type.zome_index && def.entry_index == order_type.zome_type));
        if !is_order_update {
            continue;
        }
        if let Entry::App(bytes) = entry_of(&item, entry_hash)? {
            if let Ok(order) = DeliveryOrder::try_from(SerializedBytes::from(bytes)) {
                if order.status == DeliveryStatus::DriverEnRouteToMerchant {
                    commits.push((item.action.hashed.hash.clone(), order.priority));
                }
            }
        }
    }
    let mut hands = InHand::default();
    for (_, priority) in commits.into_iter().filter(|(commit, _)| !ended.contains(commit)) {
        hands = InHand { orders: hands.orders + 1, priority: hands.priority || priority };
    }
    Ok(hands)
}

/// A driver committing to another order has room for it.
pub(crate) fn check_room(driver: &AgentPubKey, chain_top: &ActionHash, priority: bool) -> ExternResult<Result<(), &'static str>> {
    Ok(in_hand(driver, chain_top)?.taking(priority, handshake_governance::max_concurrent_deliveries()).map(drop).map_err(CarryRefusal::rule))
}

pub(crate) fn validate_carry_ended(ended: &CarryEnded, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("a carry can't end before a chain begins") };
    let committed = must_get_valid_record(ended.committed.clone())?;
    if !is_commit(&committed, author) || original_creation(ended.committed.clone())? != ended.order {
        return invalid("a carry ends on its driver's own commit to that order");
    }
    // The order left their hands: their store decided where it went, or a
    // later version of it is over, no longer theirs, or theirs to say nobody
    // came for (what's held for it stays held till the store decides).
    let basis = must_get_valid_record(ended.basis.clone())?;
    let left = if let Some(outcome) = decode::<OrderOutcome>(&basis) {
        outcome.order == ended.order
    } else {
        match Version::of(basis) {
            Some(version) if lineage::descends_from(&version, &ended.committed)? => {
                let mine = match &version.order.accepted_bid {
                    Some(bid) => decode::<Bid>(&must_get_valid_record(bid.clone())?).is_some_and(|b| &b.bidder == author),
                    None => false,
                };
                version.order.status.is_terminal() || version.order.status == DeliveryStatus::Unanswered || !mine
            }
            _ => false,
        }
    };
    if !left {
        return invalid("a carry ends on the order being over, or no longer its driver's");
    }
    // Once per commit.
    let since = committed.action().timestamp();
    let ended_type: ScopedEntryDefIndex = UnitEntryTypes::CarryEnded.try_into()?;
    let again = handshake_integrity_support::chain::entries_since(author, prev_action, since, &[ended_type])?
        .into_iter()
        .filter_map(|bytes| CarryEnded::try_from(bytes).ok())
        .any(|earlier| earlier.committed == ended.committed);
    require(!again, "that carry has already ended")
}
