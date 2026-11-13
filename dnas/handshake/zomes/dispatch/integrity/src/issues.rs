//! Validation for how an order settles -- see `dispatch_types::issues` for
//! the flow. What it guarantees:
//!
//! - only an order's own customer reports issues with it, only for items on
//!   it, never more units than were ordered -- or, once, the delivery
//!   itself, if a driver brought it, worth their share of its fee; only its
//!   store answers each,
//!   once -- accepting it for a part of its worth only between nothing and
//!   all of it;
//! - only the order's store decides its outcome and its settlement, once
//!   each -- so every payment cites the same decision, and none can
//!   contradict another;
//! - *Delivered* only on the order completed with proof -- or on the
//!   driver's word that nobody came, or their proven pickup, once the
//!   customer's time to say otherwise has run; *not delivered* only on the
//!   customer's claim, made after the driver's proven pickup, and never by a
//!   store that cancelled the order;
//! - a settlement's refund is never more than the issues it cites are worth
//!   of what the customer paid (a report on the delivery, their share of its
//!   fee, which the store refunds out of the food's payment) -- plus, for a delivery its customer
//!   collected themselves, the store's share of the fee it would have paid a
//!   driver, which it must refund (`collection_compensation`).

use super::*;
use crate::claims::wrote_update_of;
use dispatch_types::{claimed_value, service_value, IssueResponse, ItemIssue, ItemSettlement, OrderOutcome, Outcome};
use handshake_integrity_support::chain::wrote_since;
use handshake_integrity_support::{decode, original_creation, valid};

/// An order's terms an issue is judged against: its parties, and each line
/// as (item, unit price, quantity ordered).
pub(crate) struct OrderForIssues {
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    pub order_total: u64,
    /// Each line's (unit price, quantity), in order.
    pub lines: Vec<(u64, u32)>,
    pub delivery: bool,
}

/// `order` (its original action), with each line priced from the exact
/// version it was ordered at.
pub(crate) fn order_for_issues(order: &ActionHash) -> ExternResult<Option<OrderForIssues>> {
    if &original_creation(order.clone())? != order {
        return Ok(None);
    }
    let record = must_get_valid_record(order.clone())?;
    let (requester, merchant, order_total, lines, delivery) = if let Some(o) = decode::<DeliveryOrder>(&record) {
        (o.requester, o.merchant, o.order_total, o.lines, true)
    } else if let Some(o) = decode::<PickupOrder>(&record) {
        (o.requester, o.merchant, o.order_total, o.lines, false)
    } else {
        return Ok(None);
    };
    let mut priced = Vec::with_capacity(lines.len());
    let mut pricer = dispatch_types::LinePricer::default();
    for line in lines {
        let version = must_get_valid_record(line.priced_version.clone())?;
        let price = if let Some(item) = decode::<MenuItem>(&version) {
            // The order was valid, so its choices price.
            match pricer.unit_price(&item.as_sold(line.on_sale), &line.selections)? {
                Ok(price) => price,
                Err(_) => return Ok(None),
            }
        } else if let Some(bag) = decode::<catalog_types::GoodieBag>(&version) {
            bag.price_cents
        } else {
            return Ok(None);
        };
        priced.push((price, line.quantity));
    }
    Ok(Some(OrderForIssues { requester, merchant, order_total, lines: priced, delivery }))
}

/// A customer's report of items missing or wrong: theirs, once they have
/// the order, about items on it -- each item reported once, so an order's
/// reports are bounded by its lines and no item is claimed twice.
pub(crate) fn validate_item_issue(issue: &ItemIssue, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(terms) = order_for_issues(&issue.order)? else {
        return invalid("an issue is reported about an order, by its original action");
    };
    if author != &terms.requester {
        return invalid("only the order's customer reports issues with it");
    }
    let received = if terms.delivery {
        version_of::<DeliveryOrder>(&issue.order, &issue.received)?.is_some_and(|(_, v)| matches!(v.status, DeliveryStatus::Delivered | DeliveryStatus::Collected))
    } else {
        version_of::<PickupOrder>(&issue.order, &issue.received)?.is_some_and(|(record, v)| v.status == PickupStatus::PickedUp && record.action().author() == author)
    };
    if !received {
        return invalid("an issue is reported once the customer has the order, citing the version that shows it");
    }
    let Some(prev) = prev_action else { return invalid("an issue can't open a chain") };
    let placed = must_get_action(issue.order.clone())?.hashed.content.header.timestamp;
    let reported_again = |earlier: &ItemIssue| earlier.order == issue.order && (earlier.lines.iter().any(|old| issue.lines.iter().any(|new| new.line == old.line)) || (earlier.service && issue.service));
    if wrote_since::<ItemIssue>(author, prev, placed, UnitEntryTypes::ItemIssue.try_into()?, reported_again)? {
        return invalid("each line of an order, and its delivery, is reported once");
    }
    let bounded = handshake_integrity_support::sealed_chunks_problem("an issue's evidence", &issue.sealed_for_store, handshake_integrity_support::max_sealed_image_bytes()).is_none();
    if !bounded {
        return invalid("an issue's evidence may hold a note and at most one photo, within the network's image limit");
    }
    // The delivery itself: no items, on one a driver brought -- not one the
    // customer collected -- whose fee they paid a share of.
    if issue.service {
        if !issue.lines.is_empty() {
            return invalid("a report on the delivery names no items");
        }
        return match service_value_of(issue, terms.delivery)? {
            Some(value) if value > 0 => valid(),
            _ => invalid("a report on the delivery is for one a driver brought, whose fee the customer paid a share of"),
        };
    }
    if issue.lines.is_empty() {
        return invalid("an issue names at least one line");
    }
    for (i, line) in issue.lines.iter().enumerate() {
        if issue.lines[..i].iter().any(|l| l.line == line.line) {
            return invalid("each line appears once in an issue");
        }
        let Some((_, ordered)) = terms.lines.get(line.line as usize) else {
            return invalid("an issue names only lines on the order");
        };
        if line.quantity == 0 || line.quantity > *ordered {
            return invalid("an issue claims between one and the number ordered of each line");
        }
    }
    valid()
}

/// What a report on a delivery's service is worth -- the customer's share of
/// the fee for the driver who delivered it, by the version it cites -- or
/// `None` if it can't be one: not a delivery, or not one a driver delivered.
fn service_value_of(issue: &ItemIssue, delivery: bool) -> ExternResult<Option<u64>> {
    if !delivery {
        return Ok(None);
    }
    let Some((_, version)) = version_of::<DeliveryOrder>(&issue.order, &issue.received)? else { return Ok(None) };
    let Some(bid) = version.accepted_bid.filter(|_| version.status == DeliveryStatus::Delivered) else { return Ok(None) };
    let Some(bid) = decode::<Bid>(&must_get_valid_record(bid)?) else { return Ok(None) };
    Ok(Some(service_value(bid.price_offer, version.delivery_subsidy_percent)))
}

/// What an issue is worth, of what its customer paid: its items' share, or
/// for the delivery itself, their share of its fee.
fn issue_value(issue: &ItemIssue, terms: &OrderForIssues) -> ExternResult<u64> {
    if issue.service {
        return Ok(service_value_of(issue, terms.delivery)?.unwrap_or(0));
    }
    let claimed: Vec<(u32, u32)> = issue.lines.iter().map(|l| (l.line, l.quantity)).collect();
    Ok(claimed_value(&terms.lines, terms.order_total, &claimed))
}

pub(crate) fn validate_issue_response(response: &IssueResponse, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let issue_record = must_get_valid_record(response.issue.clone())?;
    let Some(issue) = decode::<ItemIssue>(&issue_record) else { return invalid("a response answers an issue") };
    let Some(terms) = order_for_issues(&issue.order)? else { return invalid("the issue's order is gone") };
    if author != &terms.merchant {
        return invalid("only the order's store answers an issue with it");
    }
    // So the walk below, from the issue's timestamp, sees every answer to
    // it: none can be dated before it.
    if at < issue_record.action().timestamp() {
        return invalid("an answer comes after the issue it answers");
    }
    // A part is of an issue accepted, more than nothing and less than all
    // it's worth -- all of it is `None`, a decline refunds nothing.
    if let Some(part) = response.refund {
        let value = issue_value(&issue, &terms)?;
        if !response.accept || part == 0 || part >= value {
            return invalid("a partial refund accepts an issue for more than nothing and less than it's worth");
        }
    }
    let Some(prev) = prev_action else { return invalid("a response can't open a chain") };
    let answered = wrote_since::<IssueResponse>(author, prev, issue_record.action().timestamp(), UnitEntryTypes::IssueResponse.try_into()?, |r| r.issue == response.issue)?;
    require(!answered, "a store answers each issue once")
}

/// When `order` was placed: every decision about it is dated after, so a
/// walk of the store's chain back to it sees all of them.
fn placed_at(order: &ActionHash) -> ExternResult<Timestamp> {
    Ok(must_get_action(order.clone())?.hashed.content.header.timestamp)
}

/// A version of `order`, decoded -- `None` if it isn't one.
fn version_of<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(order: &ActionHash, version: &ActionHash) -> ExternResult<Option<(Record, T)>> {
    if &original_creation(version.clone())? != order {
        return Ok(None);
    }
    let record = must_get_valid_record(version.clone())?;
    Ok(decode::<T>(&record).map(|v| (record, v)))
}

pub(crate) fn validate_outcome(outcome: &OrderOutcome, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(terms) = order_for_issues(&outcome.order)? else { return invalid("an outcome is decided for an order, by its original action") };
    if !terms.delivery {
        return invalid("only a delivery has an outcome to decide");
    }
    if author != &terms.merchant {
        return invalid("only the order's store decides its outcome");
    }
    let placed = placed_at(&outcome.order)?;
    if at < placed {
        return invalid("an outcome is decided after its order was placed");
    }
    let Some(prev) = prev_action else { return invalid("an outcome can't open a chain") };
    let decided = wrote_since::<OrderOutcome>(author, prev, placed, UnitEntryTypes::OrderOutcome.try_into()?, |o| o.order == outcome.order)?;
    if decided {
        return invalid("an order's outcome is decided once");
    }
    match &outcome.outcome {
        Outcome::Delivered { proof } => {
            let Some((record, version)) = version_of::<DeliveryOrder>(&outcome.order, proof)? else { return invalid("a delivered outcome cites a version of its order") };
            match version.status {
                DeliveryStatus::Delivered => valid(),
                // The driver's word that nobody came, upheld: only once the
                // customer's report window from it has run, so they've had
                // it to dispute -- the store deciding a dispute included.
                DeliveryStatus::Unanswered => {
                    let window_ends = (record.action().timestamp() + handshake_governance::report_window()).map_err(|e| wasm_error!(WasmErrorInner::Guest(e.to_string())))?;
                    require(at >= window_ends, "a store upholds a driver's word that nobody came only once the customer's report window has run")
                }
                // Picked up, and nobody's said more: no proof it arrived, no
                // claim it didn't, past the lapse (when the customer's app
                // says it never came) and their report window after -- on
                // proof of the time, as it costs the customer if claimed
                // early. A driver who kept it and a customer who never says
                // so can't leave the store unpaid; a customer who never got
                // it appeals.
                DeliveryStatus::PickedUp => {
                    let settles_at = dispatch_types::lineage::stalled_delivery_settles_at(record.action().timestamp());
                    match handshake_integrity_support::beacon::proves_past(outcome.beacon.as_ref(), settles_at) {
                        Ok(()) => valid(),
                        Err(_) => invalid("a store settles a pickup nobody's said more of as delivered only once the customer's time to claim has run, proved"),
                    }
                }
                _ => invalid("a delivered outcome cites the order completed on proof the customer has it, the driver's word that nobody came, or their pickup"),
            }
        }
        Outcome::NotDelivered { claim } => {
            let Some((record, version)) = version_of::<DeliveryOrder>(&outcome.order, claim)? else { return invalid("a claim is a version of its order") };
            // The only way into Disputed is the customer's claim -- from
            // PickedUp, which the driver reached on proof of the pickup, or
            // from the driver's word that nobody came.
            if version.status != DeliveryStatus::Disputed || record.action().author() != &terms.requester {
                return invalid("not delivered cites the customer's claim that it never arrived");
            }
            // A store that cancelled the order (refunding the customer) can't
            // also take the driver's collateral for it.
            let cancelled = wrote_update_of(author, prev, &outcome.order, |v| v.status == DeliveryStatus::Cancelled)?;
            require(!cancelled, "a store that cancelled an order can't decide it went undelivered")
        }
    }
}

pub(crate) fn validate_settlement(settlement: &ItemSettlement, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(terms) = order_for_issues(&settlement.order)? else { return invalid("a settlement is for an order, by its original action") };
    if author != &terms.merchant {
        return invalid("only the order's store settles it");
    }
    let placed = placed_at(&settlement.order)?;
    if at < placed {
        return invalid("a settlement comes after its order was placed");
    }
    // That the customer has the order -- and, collected from the store,
    // what the store owes them for coming.
    let (has_it, owed) = if terms.delivery {
        let record = must_get_valid_record(settlement.basis.clone())?;
        let delivered = decode::<OrderOutcome>(&record).is_some_and(|o| o.order == settlement.order && matches!(o.outcome, Outcome::Delivered { .. }));
        match version_of::<DeliveryOrder>(&settlement.order, &settlement.basis)? {
            Some((record, version)) if !delivered && version.status == DeliveryStatus::Collected => (true, dispatch_types::lineage::collection_owed(&dispatch_types::lineage::Version { record, order: version })?),
            _ => (delivered, 0),
        }
    } else {
        (version_of::<PickupOrder>(&settlement.order, &settlement.basis)?.is_some_and(|(record, v)| v.status == PickupStatus::PickedUp && record.action().author() == &terms.requester), 0)
    };
    if !has_it {
        return invalid("a settlement cites that the customer has the order: its delivered outcome, or its collection");
    }
    if settlement.refund < owed {
        return invalid("a delivery its customer collected refunds them the store's share of the fee it would have paid a driver");
    }
    let mut claimed: Vec<(u32, u32)> = Vec::new();
    let mut service: u64 = 0;
    for (i, issue_ref) in settlement.issues.iter().enumerate() {
        if settlement.issues[..i].contains(issue_ref) {
            return invalid("a settlement cites each issue once");
        }
        let issue_record = must_get_valid_record(issue_ref.clone())?;
        let Some(issue) = decode::<ItemIssue>(&issue_record) else { return invalid("a settlement cites issues") };
        if issue.order != settlement.order {
            return invalid("a settlement cites only its own order's issues");
        }
        if issue_record.action().timestamp() > at {
            return invalid("a settlement cites only issues reported before it");
        }
        if issue.service {
            service = service.saturating_add(issue_value(&issue, &terms)?);
        }
        claimed.extend(issue.lines.iter().map(|l| (l.line, l.quantity)));
    }
    // The delivery's share of its fee comes out of what the store collects
    // for the food, like any refund: never more than the food cost.
    if settlement.refund > claimed_value(&terms.lines, terms.order_total, &claimed).saturating_add(service).saturating_add(owed).min(terms.order_total) {
        return invalid("a refund can't exceed what the cited issues are worth");
    }
    let Some(prev) = prev_action else { return invalid("a settlement can't open a chain") };
    let again = wrote_since::<ItemSettlement>(author, prev, placed, UnitEntryTypes::ItemSettlement.try_into()?, |s| s.order == settlement.order)?;
    require(!again, "an order is settled once")
}
