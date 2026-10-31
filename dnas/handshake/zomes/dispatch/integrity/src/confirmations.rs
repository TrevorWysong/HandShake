//! A customer's confirmations about their own order, on their own chain --
//! what decides, without trusting either side's clock, whether cancelling
//! costs them anything (`ledger_integrity`'s food rule) and whether a promo
//! use comes back (`checks::check_promo_limits`):
//!
//! - `OrderConfirmation`: their app saw the store start on it (the version
//!   that set `ready_by`). Cancelling after this owes the food; before, it
//!   costs nothing. Their app writes it by itself, the moment it sees it.
//! - `DeclineNoted`: their app saw the store decline it before accepting.
//!
//! Each once per order, by the order's customer, citing the store's own
//! version -- and never after they cancelled it themselves.

use super::*;
use crate::issues::{order_for_issues, OrderForIssues};
use handshake_integrity_support::{decode, original_creation};

/// The store's version `version` of `order`, if it is one: an update by the
/// order's store, decoded.
fn store_version(order: &ActionHash, merchant: &AgentPubKey, version: &ActionHash) -> ExternResult<Option<(Record, lineage::AnyVersion)>> {
    let record = must_get_valid_record(version.clone())?;
    if !matches!(record.action().data, ActionData::Update(_)) || record.action().author() != merchant || &original_creation(version.clone())? != order {
        return Ok(None);
    }
    let any = decode::<DeliveryOrder>(&record).map(lineage::AnyVersion::Delivery).or_else(|| decode::<PickupOrder>(&record).map(lineage::AnyVersion::Pickup));
    Ok(any.map(|v| (record, v)))
}

/// What both share: written by the order's customer, once, and never after
/// they cancelled it. The order's terms, or why not.
fn by_its_customer(order: &ActionHash, author: &AgentPubKey, prev_action: Option<&ActionHash>, entry_type: UnitEntryTypes, again: impl Fn(SerializedBytes) -> bool) -> ExternResult<Result<OrderForIssues, &'static str>> {
    let Some(terms) = order_for_issues(order)? else { return Ok(Err("a confirmation is about an order, by its original action")) };
    if author != &terms.requester {
        return Ok(Err("only the order's customer confirms what they saw of it"));
    }
    let Some(prev) = prev_action else { return Ok(Err("a confirmation can't open a chain")) };
    let placed = must_get_action(order.clone())?.hashed.content.timestamp();
    if handshake_integrity_support::chain::entries_since(author, prev, placed, &[entry_type.try_into()?])?.into_iter().any(again) {
        return Ok(Err("each is written once an order"));
    }
    if lineage::wrote_any(author, prev, order, |v| v.cancellation().is_some())? {
        return Ok(Err("a customer who cancelled an order writes nothing more on it"));
    }
    Ok(Ok(terms))
}

pub(crate) fn validate_confirmation(c: &OrderConfirmation, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let terms = match by_its_customer(&c.order, author, prev_action, UnitEntryTypes::OrderConfirmation, |bytes| OrderConfirmation::try_from(bytes).is_ok_and(|e| e.order == c.order))? {
        Ok(terms) => terms,
        Err(reason) => return invalid(reason),
    };
    let started = store_version(&c.order, &terms.merchant, &c.version)?.is_some_and(|(_, v)| v.ready_by().is_some());
    require(started, "a confirmation cites the store's version that started on the order")
}

pub(crate) fn validate_decline_noted(d: &DeclineNoted, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let terms = match by_its_customer(&d.order, author, prev_action, UnitEntryTypes::DeclineNoted, |bytes| DeclineNoted::try_from(bytes).is_ok_and(|e| e.order == d.order))? {
        Ok(terms) => terms,
        Err(reason) => return invalid(reason),
    };
    let Some((record, version)) = store_version(&d.order, &terms.merchant, &d.version)? else { return invalid("a decline is the store's own version of the order") };
    if !matches!(version.cancellation(), Some(Cancellation::ByStore(_))) {
        return invalid("a decline is the store calling the order off");
    }
    let ActionData::Update(update) = &record.action().data else { return invalid("a decline is an update") };
    let prior = must_get_valid_record(update.original_action_address.clone())?;
    let from_placed = decode::<DeliveryOrder>(&prior).is_some_and(|o| o.status == DeliveryStatus::Placed) || decode::<PickupOrder>(&prior).is_some_and(|o| o.status == PickupStatus::Placed);
    require(from_placed, "a decline is from before the store accepted")
}
