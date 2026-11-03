//! What a payment's capture rests on: an order's version, or its store's
//! decision, read as a `direct::Basis` -- and the checks only the parties'
//! chains can answer (`direct::ChainCheck`). Used by validation of every
//! `PaymentSettlement`, and by the payee's own app finding what it's owed,
//! so the two can never disagree.

use super::*;
use dispatch_types::direct::{Basis, Cancelled, ChainCheck, Part, Stage};
use dispatch_types::lineage::{self, Version};
use handshake_integrity_support::{decode, original_creation};

/// How far a delivery had got.
pub fn delivery_stage(status: &DeliveryStatus) -> Stage {
    match status {
        DeliveryStatus::Scheduled | DeliveryStatus::Placed => Stage::Waiting,
        // Collecting: no driver, the customer coming for it.
        DeliveryStatus::Open | DeliveryStatus::Collecting => Stage::Accepted,
        DeliveryStatus::BidAccepted | DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed => Stage::DriverAssigned,
        DeliveryStatus::DriverAtStore => Stage::AtStore,
        _ => Stage::Other,
    }
}

/// How far a pickup order had got.
pub fn pickup_stage(status: &PickupStatus) -> Stage {
    match status {
        PickupStatus::Placed => Stage::Waiting,
        PickupStatus::MerchantConfirmed | PickupStatus::ReadyForPickup => Stage::Accepted,
        _ => Stage::Other,
    }
}

/// The bid a part is for, if it's a driver's.
pub fn part_bid(part: &Part) -> Option<&ActionHash> {
    match &part.purpose {
        HoldPurpose::Food => None,
        HoldPurpose::DriverPay { bid } | HoldPurpose::Subsidy { bid } | HoldPurpose::Collateral { bid } => Some(bid),
    }
}

/// The bid behind the version of `order` at `version_ref`.
fn bid_at(order: &ActionHash, version_ref: &ActionHash) -> ExternResult<Option<ActionHash>> {
    if &original_creation(version_ref.clone())? != order {
        return Ok(None);
    }
    Ok(Version::at(version_ref)?.and_then(|v| v.order.accepted_bid))
}

/// What `basis_ref` -- an order's version, or its store's decision -- means
/// for `part` of `order` (its original action), whose store is `merchant`;
/// or why it means nothing. The store's decisions are validated as its own
/// (`issues`): one each per order, by its store.
pub fn basis_of(basis_ref: &ActionHash, order: &ActionHash, merchant: &AgentPubKey, delivery: bool, part: &Part) -> ExternResult<Result<Basis, &'static str>> {
    let record = must_get_valid_record(basis_ref.clone())?;
    if let Some(outcome) = decode::<OrderOutcome>(&record) {
        if &outcome.order != order {
            return Ok(Err("that outcome is another order's"));
        }
        return Ok(Ok(match outcome.outcome {
            Outcome::Delivered { proof } => Basis::Delivered { bid: bid_at(order, &proof)? },
            Outcome::NotDelivered { claim } => Basis::NotDelivered { bid: bid_at(order, &claim)? },
        }));
    }
    if let Some(settlement) = decode::<ItemSettlement>(&record) {
        return Ok(if &settlement.order == order { Ok(Basis::Settled { refund: settlement.refund }) } else { Err("that settlement is another order's") });
    }
    if &original_creation(basis_ref.clone())? != order {
        return Ok(Err("a payment's basis must be about its own order"));
    }
    if !delivery {
        let Some(version) = decode::<PickupOrder>(&record) else { return Ok(Err("that isn't a basis for a payment")) };
        let from = prior_version::<PickupOrder>(&record)?.map(|p| pickup_stage(&p.status));
        return Ok(match (version.cancellation, from) {
            (Some(by), Some(from)) => Ok(Basis::Cancelled(Cancelled { by, from, cooking: from == Stage::Accepted, bid: None, liable: None })),
            _ => Err("that version of the order entitles no payment"),
        });
    }
    let Some(version) = Version::of(record) else { return Ok(Err("that isn't a basis for a payment")) };
    let Some(prior) = version.prior()? else { return Ok(Err("that version of the order entitles no payment")) };
    let bid = part_bid(part);
    // A driver leaving -- this part's.
    let released = version.released(&prior).filter(|_| matches!(version.order.status, DeliveryStatus::Open | DeliveryStatus::Collecting));
    if let Some(left) = released.filter(|left| Some(left) == bid) {
        // The store recording the customer collecting it: the food reaches
        // them another way, so the driver no longer answers for it.
        let collecting = version.order.status == DeliveryStatus::Collecting && version.author() == merchant;
        if collecting && part.portion == Portion::Collateral {
            return Ok(Ok(Basis::Replaced { bid: left }));
        }
        let at_store = prior.order.status == DeliveryStatus::DriverAtStore;
        return Ok(Ok(Basis::Released { bid: left, store_late: lineage::is_store_late_release(&version, &prior)?, at_store }));
    }
    // The store confirming a later driver than this part's, or recording the
    // customer collecting it.
    if let Some(bid) = bid {
        let collecting = version.order.status == DeliveryStatus::Collecting && prior.order.status != DeliveryStatus::Collecting;
        let replacing = lineage::confirms_driver(&version, &prior) || collecting;
        if replacing && version.order.accepted_bid.as_ref() != Some(bid) && version.author() == merchant {
            let left_earlier = lineage::find_back(version.clone(), |v, p| p.and_then(|p| v.released(p)).filter(|b| b == bid))?.is_some();
            if left_earlier {
                return Ok(Ok(Basis::Replaced { bid: bid.clone() }));
            }
        }
    }
    // The order cancelled.
    let Some(by) = version.order.cancellation.clone() else { return Ok(Err("that version of the order entitles no payment")) };
    if prior.order.status == DeliveryStatus::Cancelled {
        return Ok(Err("that version of the order entitles no payment"));
    }
    let liable = if by == Cancellation::NoDriver { lineage::liable_release(&prior)?.map(|(_, bid)| bid) } else { None };
    Ok(Ok(Basis::Cancelled(Cancelled { by, from: delivery_stage(&prior.order.status), cooking: prior.order.ready_by.is_some(), bid: prior.order.accepted_bid.clone(), liable })))
}

/// Whether a chain check holds, for a payee claiming `part` of `order` on
/// the cancellation at `cancel_ref`, as of the payee's chain at
/// `chain_top`:
///
/// - **ConfirmedCooking** (the store, for the food): the customer who
///   cancelled had confirmed seeing the store start before they did, on
///   their own chain behind the cancellation -- and the store never called
///   it off itself. Validation sees only the version a cancellation updates,
///   so a customer could cancel on an older one; their chain says what they
///   knew when.
/// - **CustomerTook** (the driver, for their fee): the customer who
///   cancelled had accepted this part's driver before they did, and the
///   driver never left it themselves.
pub fn chain_check(check: ChainCheck, cancel_ref: &ActionHash, order: &ActionHash, part: &Part, payee: &AgentPubKey, chain_top: &ActionHash) -> ExternResult<bool> {
    let cancel = must_get_valid_record(cancel_ref.clone())?;
    let customer = cancel.action().author().clone();
    match check {
        ChainCheck::ConfirmedCooking => {
            if !lineage::saw_start(&customer, cancel_ref, order, payee)? {
                return Ok(false);
            }
            Ok(!lineage::wrote_any(payee, chain_top, order, |v| matches!(v.cancellation(), Some(Cancellation::ByStore(_))))?)
        }
        ChainCheck::CustomerTook => {
            let Some(bid) = part_bid(part) else { return Ok(false) };
            if !lineage::wrote_any(&customer, cancel_ref, order, |v| v.accepted_bid() == Some(bid))? {
                return Ok(false);
            }
            Ok(!lineage::wrote(payee, chain_top, order, |v, p| v.released(p).as_ref() == Some(bid))?)
        }
    }
}

/// The version an update replaced, as `T`.
fn prior_version<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &Record) -> ExternResult<Option<T>> {
    let ActionData::Update(update) = &record.action().data else { return Ok(None) };
    Ok(decode::<T>(&must_get_valid_record(update.original_action_address.clone())?))
}
