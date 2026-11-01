//! Money held for an order: a hold priced from the order's terms, and each
//! part of it given back (waived) or forfeited, once.

use super::*;

/// An order's terms (from its as-created record) and, for a purpose that
/// names one, the bid -- which must be on this order.
pub(crate) fn hold_context(order: &ActionHash, purpose: &HoldPurpose) -> ExternResult<Result<(OrderTerms, Option<Bid>), &'static str>> {
    if &original_creation(order.clone())? != order {
        return Ok(Err("a hold must name the order's original action"));
    }
    let record = must_get_valid_record(order.clone())?;
    let terms = if let Some(order) = decode::<DeliveryOrder>(&record) {
        OrderTerms::of_delivery(&order)
    } else if let Some(order) = decode::<PickupOrder>(&record) {
        OrderTerms::of_pickup(&order)
    } else {
        return Ok(Err("a hold must be for an order"));
    };
    let bid_ref = match purpose {
        HoldPurpose::Food => None,
        HoldPurpose::DriverPay { bid } | HoldPurpose::Subsidy { bid } | HoldPurpose::Collateral { bid } => Some(bid),
    };
    let bid = match bid_ref {
        Some(bid_ref) => {
            let Some(bid) = decode::<Bid>(&must_get_valid_record(bid_ref.clone())?) else { return Ok(Err("a hold's bid must be a bid")) };
            if &original_creation(bid.order_ref.clone())? != order {
                return Ok(Err("a hold's bid must be on its order"));
            }
            Some(bid)
        }
        None => None,
    };
    Ok(Ok((terms, bid)))
}

pub(crate) fn validate_hold(entry: &LedgerEntry, order: &ActionHash, purpose: &HoldPurpose, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let (terms, bid) = match hold_context(order, purpose)? {
        Ok(context) => context,
        Err(reason) => return invalid(reason),
    };
    let Some((payer, shares)) = hold_terms(&terms, purpose, bid.as_ref()) else {
        return invalid("that kind of hold doesn't fit this order");
    };
    if &payer != author {
        return invalid("a hold is paid by whoever owes it");
    }
    if shares.is_empty() || entry.amount != hold_amount(&shares) {
        return invalid("a hold must set aside exactly what its order's terms owe");
    }
    valid()
}

/// A hold, as a collection or waiver needs it: who paid it, its parts, and
/// when it was made.
pub(crate) struct HoldContext {
    pub(crate) order: ActionHash,
    pub(crate) terms: OrderTerms,
    pub(crate) purpose: HoldPurpose,
    pub(crate) payer: AgentPubKey,
    pub(crate) shares: Vec<Share>,
    pub(crate) held_at: Timestamp,
}

pub(crate) fn hold_of(hold_ref: &ActionHash) -> ExternResult<Result<HoldContext, &'static str>> {
    let record = must_get_valid_record(hold_ref.clone())?;
    let Some(LedgerEntry { kind: LedgerKind::Hold { order, purpose }, .. }) = decode::<LedgerEntry>(&record) else {
        return Ok(Err("that isn't a hold"));
    };
    let (terms, bid) = match hold_context(&order, &purpose)? {
        Ok(context) => context,
        Err(reason) => return Ok(Err(reason)),
    };
    let Some((payer, shares)) = hold_terms(&terms, &purpose, bid.as_ref()) else { return Ok(Err("that hold doesn't fit its order")) };
    Ok(Ok(HoldContext { order, terms, purpose, payer, shares, held_at: record.action().timestamp() }))
}

/// Whether `author` has already collected or waived this part of the hold
/// (or, as its payer, taken an issuer's grant in its place) -- every such
/// entry is on their own chain, after the hold was made.
pub(crate) fn already_decided(author: &AgentPubKey, prev_action: &ActionHash, hold_ref: &ActionHash, portion: Portion, held_at: Timestamp) -> ExternResult<bool> {
    Ok(ledger_since(author, prev_action, held_at)?.into_iter().any(|e| match &e.entry.kind {
        LedgerKind::Collect { hold, portion: p, .. } | LedgerKind::Waive { hold, portion: p } | LedgerKind::Returned { hold, portion: p, .. } => hold == hold_ref && *p == portion,
        LedgerKind::Forfeit { hold, .. } => hold == hold_ref && portion == Portion::Collateral,
        _ => false,
    }))
}

pub(crate) fn validate_waive(hold_ref: &ActionHash, portion: Portion, author: &AgentPubKey, at: Timestamp, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let hold = match hold_of(hold_ref)? {
        Ok(hold) => hold,
        Err(reason) => return invalid(reason),
    };
    if !hold.shares.iter().any(|s| s.portion == portion && &s.recipient == author) {
        return invalid("only a part's recipient may waive it");
    }
    if at < hold.held_at {
        return invalid("a hold is decided after it's made");
    }
    if already_decided(author, prev_action, hold_ref, portion, hold.held_at)? {
        return invalid("that part of the hold has already been decided");
    }
    valid()
}

/// A driver conceding their collateral: theirs to concede (they paid it),
/// once, on the store's decision that the order never arrived.
pub(crate) fn validate_forfeit(hold_ref: &ActionHash, basis_ref: &ActionHash, author: &AgentPubKey, at: Timestamp, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let hold = match hold_of(hold_ref)? {
        Ok(hold) => hold,
        Err(reason) => return invalid(reason),
    };
    if !matches!(hold.purpose, HoldPurpose::Collateral { .. }) || &hold.payer != author {
        return invalid("only a driver forfeits, and only their own collateral");
    }
    if at < hold.held_at {
        return invalid("a hold is decided after it's made");
    }
    if already_decided(author, prev_action, hold_ref, Portion::Collateral, hold.held_at)? {
        return invalid("that part of the hold has already been decided");
    }
    let ours = |bid: &Option<ActionHash>| bid.as_ref() == bid_of(&hold.purpose);
    match basis_of(basis_ref, &hold)? {
        Ok(Basis::NotDelivered { bid }) if ours(&bid) => valid(),
        Ok(Basis::Cancelled(Cancelled { by: Cancellation::NoDriver, liable, .. })) if ours(&liable) => valid(),
        Ok(_) => invalid("collateral is forfeited only when the store decides the order never arrived, or ends it for want of the driver who left it"),
        Err(reason) => invalid(reason),
    }
}
