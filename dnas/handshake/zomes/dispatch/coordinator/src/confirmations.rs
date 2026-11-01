//! The customer's app confirming what it saw of their own orders
//! (`dispatch_integrity::confirmations`): that the store started on one --
//! after which cancelling owes the food -- or declined it before accepting,
//! which gives back any promo use. Written by itself, as soon as it sees
//! them, by the customer's own sweeps.

use dispatch_integrity::*;
use handshake_coordinator_support::chain::mine;
use handshake_coordinator_support::{decode_or, isolated};
use hdk::prelude::*;

/// How far back the sweep looks: an order is accepted or declined within
/// minutes of being placed, so a day is ample.
const LOOK_BACK_MICROS: i64 = 86_400_000_000;

fn me() -> ExternResult<AgentPubKey> {
    Ok(agent_info()?.agent_initial_pubkey)
}

/// Every version of an order, across any branches.
fn versions_of(order: &ActionHash) -> ExternResult<Vec<Record>> {
    let mut out = Vec::new();
    let mut frontier = vec![order.clone()];
    while let Some(hash) = frontier.pop() {
        let Some(Details::Record(details)) = get_details(hash, GetOptions::default())? else { continue };
        frontier.extend(details.updates.iter().map(|u| u.action_address().clone()));
        out.push(details.record);
    }
    Ok(out)
}

/// The order's fields these care about, from any version.
struct Fields {
    requester: AgentPubKey,
    merchant: AgentPubKey,
    started: bool,
    cancellation: Option<Cancellation>,
    placed: bool,
}

fn fields(record: &Record) -> Option<Fields> {
    if let Some(o) = decode_or::<DeliveryOrder>(record) {
        return Some(Fields { requester: o.requester, merchant: o.merchant, started: o.ready_by.is_some(), cancellation: o.cancellation, placed: o.status == DeliveryStatus::Placed });
    }
    decode_or::<PickupOrder>(record).map(|o| Fields { requester: o.requester, merchant: o.merchant, started: o.ready_by.is_some(), cancellation: o.cancellation, placed: o.status == PickupStatus::Placed })
}

/// What the caller has already written about `order`, since it was placed:
/// a confirmation, a decline noted, or their own cancellation.
fn settled_for(order: &ActionHash, placed: Timestamp) -> ExternResult<bool> {
    let types = [EntryType::try_from(UnitEntryTypes::OrderConfirmation)?, EntryType::try_from(UnitEntryTypes::DeclineNoted)?];
    let noted = mine(&types).since(placed).any(|r| decode_or::<OrderConfirmation>(r).is_some_and(|c| &c.order == order) || decode_or::<DeclineNoted>(r).is_some_and(|d| &d.order == order))?;
    if noted {
        return Ok(true);
    }
    let orders = [EntryType::try_from(UnitEntryTypes::DeliveryOrder)?, EntryType::try_from(UnitEntryTypes::PickupOrder)?];
    mine(&orders).since(placed).any(|r| matches!(r.action().data, ActionData::Update(_)) && fields(r).is_some_and(|f| f.cancellation.is_some()) && handshake_coordinator_support::original_action_of(r.action_address().clone()).ok().as_ref() == Some(order))
}

/// Confirms or notes what the caller's app has seen of one of their orders
/// (its original action), if there's anything new. `None` if not.
#[hdk_extern]
pub fn confirm_what_i_saw(order: ActionHash) -> ExternResult<Option<ActionHash>> {
    let Some(original) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(Fields { requester, merchant, .. }) = fields(&original) else { return Ok(None) };
    if requester != me()? || settled_for(&order, original.action().timestamp())? {
        return Ok(None);
    }
    let versions = versions_of(&order)?;
    let by_store = |r: &&Record| r.action().author() == &merchant && matches!(r.action().data, ActionData::Update(_));
    // The store declining it from Placed.
    for record in versions.iter().filter(by_store) {
        if !fields(record).is_some_and(|f| matches!(f.cancellation, Some(Cancellation::ByStore(_)))) {
            continue;
        }
        let ActionData::Update(update) = &record.action().data else { continue };
        let from_placed = versions.iter().find(|r| r.action_address() == &update.original_action_address).and_then(fields).is_some_and(|f| f.placed);
        if from_placed {
            let hash = create_entry(&EntryTypes::DeclineNoted(DeclineNoted { order: order.clone(), version: record.action_address().clone() }))?;
            return Ok(Some(hash));
        }
    }
    // The store starting on it.
    if let Some(record) = versions.iter().filter(by_store).find(|r| fields(r).is_some_and(|f| f.started)) {
        let hash = create_entry(&EntryTypes::OrderConfirmation(OrderConfirmation { order: order.clone(), version: record.action_address().clone() }))?;
        create_link(order, hash.clone(), LinkTypes::OrderToConfirmation, ())?;
        return Ok(Some(hash));
    }
    Ok(None)
}

/// Confirms what the caller's app has seen of each of their recent orders,
/// each in a call of its own. Run by the customer's sweeps.
pub(crate) fn tend_confirmations() -> ExternResult<u32> {
    let since = Timestamp::from_micros(sys_time()?.as_micros() - LOOK_BACK_MICROS);
    let types = [EntryType::try_from(UnitEntryTypes::DeliveryOrder)?, EntryType::try_from(UnitEntryTypes::PickupOrder)?];
    let mut written = 0;
    for record in mine(&types).creates().since(since).records()? {
        if isolated::<_, Option<ActionHash>>("confirm_what_i_saw", record.action_address().clone()).flatten().is_some() {
            written += 1;
        }
    }
    Ok(written)
}

/// Whether the order's customer confirmed seeing its store start on it --
/// for the store's settlement (`settlement::facts`).
pub(crate) fn customer_confirmed(order: &ActionHash, requester: &AgentPubKey) -> ExternResult<bool> {
    let query = LinkQuery::try_new(order.clone(), LinkTypes::OrderToConfirmation)?.author(requester.clone());
    Ok(!get_links(query, GetStrategy::default())?.is_empty())
}

/// Whether an order's customer saw their store start on it (see
/// `dispatch_types::lineage::saw_start`): confirmed it, or cancelled on the
/// store's started version.
pub(crate) fn saw_start(order: &ActionHash, requester: &AgentPubKey, merchant: &AgentPubKey) -> ExternResult<bool> {
    if customer_confirmed(order, requester)? {
        return Ok(true);
    }
    for record in versions_of(order)? {
        let cancels = record.action().author() == requester && fields(&record).is_some_and(|f| f.cancellation.is_some());
        if cancels && dispatch_integrity::lineage::cancels_started(record.action_address(), merchant)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether an order (its original action) was called off by its customer in
/// time: cancelled before they saw the store start, so it cost them nothing
/// -- and spent no points (the rewards zome).
#[hdk_extern]
pub fn cancelled_in_time(order: ActionHash) -> ExternResult<bool> {
    let Some(original) = get(order.clone(), GetOptions::default())? else { return Ok(false) };
    let Some(Fields { requester, merchant, .. }) = fields(&original) else { return Ok(false) };
    let by_customer = versions_of(&order)?.iter().any(|r| r.action().author() == &requester && fields(r).is_some_and(|f| f.cancellation == Some(Cancellation::ByCustomer)));
    Ok(by_customer && !saw_start(&order, &requester, &merchant)?)
}

/// Whether the caller confirmed seeing the store start on their order --
/// after which cancelling it owes the food. For its order page.
#[hdk_extern]
pub fn i_confirmed(order: ActionHash) -> ExternResult<bool> {
    customer_confirmed(&order, &me()?)
}
