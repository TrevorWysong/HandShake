//! Pickup-order validation: creation, and its own (driverless) status
//! state machine.

use super::*;
use crate::holds::{check_payment, terms_of, ExpectedPayment};
use dispatch_types::direct::PaymentLeg;
use crate::store_answer::{check_cancellation, check_ready_by, CancelledFrom, OrderUpdate};
use crate::checks::{check_order_rate, check_pricing, store_version, OrderPricing};
use crate::claims::resolve_original_creation;
use handshake_integrity_support::beacon;

/// `PickupOrder`'s sibling of `validate_new_order` -- same shape, minus
/// every check that only makes sense once a driver is in the loop
/// (dropoff/geohash, accepted_bid, delivery_receipts all simply don't
/// exist on this entry type at all, so there's nothing to check there).
pub(crate) fn validate_new_pickup_order(order: &PickupOrder, author: &AgentPubKey, action_timestamp: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a pickup order can only be authored by its own requester".into(),
        ));
    }
    if order.status != PickupStatus::Placed {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order must start Placed".into()));
    }
    if order.customer_payment.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order's payment is held when the store accepts it".into()));
    }
    if order.beacon.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order has no proof of the time: only recording it uncollected sets one".into()));
    }
    if order.cancellation.is_some() || order.ready_by.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order can't already be accepted or cancelled".into()));
    }
    if let Some(reason) = check_merchant_owns_catalog(&order.merchant, &order.catalog_ref)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    let store = match store_version(&order.catalog_ref, &order.catalog_version)? {
        Ok(store) => store,
        Err(reason) => return Ok(ValidateCallbackResult::Invalid(reason)),
    };
    let sealed = [("kitchen_note", order.kitchen_note.as_ref()), ("sealed_customer_name", order.sealed_customer_name.as_ref()), ("sealed_wake", order.sealed_wake.as_ref())];
    if let Some(reason) = sealed.into_iter().find_map(|(field, value)| value.and_then(|v| handshake_integrity_support::sealed_problem(field, v, handshake_integrity_support::limits::MAX_SEALED_BYTES))) {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    let pricing = OrderPricing {
        requester: &order.requester,
        catalog_ref: &order.catalog_ref,
        lines: &order.lines,
        order_total: order.order_total,
        promo_code_ref: order.promo_code_ref.as_ref(),
        loyalty_proof: &order.loyalty_proof,
        rewards: order.rewards.as_ref(),
        prev_action,
        scheduled: false,
        placed_at: action_timestamp,
        store: &store,
        tax_cents: order.tax_cents,
        delivery: false,
        age_confirmed: order.age_confirmed,
    };
    if let Some(reason) = check_pricing(pricing)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    if let Some(reason) = check_order_rate(author, action_timestamp, prev_action)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    Ok(ValidateCallbackResult::Valid)
}

pub(crate) fn validate_pickup_order_transition(
    order: &PickupOrder,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
    action_timestamp: Timestamp,
    prev_action: Option<&ActionHash>,
) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let prior: PickupOrder = prior_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "original_action_hash does not point at a PickupOrder entry".into()
        )))?;

    let Some(required_author) = prior.status.transition_requirement(&order.status) else {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "illegal status transition: {:?} -> {:?}",
            prior.status, order.status
        )));
    };

    let is_requester_or_merchant = &prior.requester == author || &prior.merchant == author;
    let authorized = match required_author {
        RequiredAuthor::Requester => &prior.requester == author,
        RequiredAuthor::Merchant => &prior.merchant == author,
        RequiredAuthor::RequesterOrMerchant => is_requester_or_merchant,
        // Never produced by PickupStatus::transition_requirement -- there is
        // no driver at all for this entry type.
        RequiredAuthor::AcceptedProvider | RequiredAuthor::RequesterOrProvider | RequiredAuthor::MerchantOrProvider | RequiredAuthor::AnyParty => false,
    };
    if !authorized {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "transition {:?} -> {:?} requires author role {:?}, but the author holds none of the roles it permits",
            prior.status, order.status, required_author
        )));
    }

    // A customer who cancelled an order -- on any version of it -- writes
    // nothing more on it (see the delivery rule).
    if &prior.requester == author {
        let Some(prev) = prev_action else { return Ok(ValidateCallbackResult::Invalid("an order update can't open a chain".into())) };
        let order_original = resolve_original_creation(original_action_hash.clone())?;
        if lineage::wrote_any(author, prev, &order_original, |v| v.cancellation().is_some())? {
            return Ok(ValidateCallbackResult::Invalid("a customer who cancelled an order writes nothing more on it".into()));
        }
    }
    let update = OrderUpdate {
        requester: &prior.requester,
        merchant: &prior.merchant,
        author,
        prior_written_at: prior_record.action().timestamp(),
        written_at: action_timestamp,
    };
    // A customer says they can't get an order once: the store's answer stands.
    // The only way back to ready from there is that answer, so the version
    // before this one tells.
    if prior.status == PickupStatus::ReadyForPickup && order.status == PickupStatus::Disputed {
        if let ActionData::Update(update) = &prior_record.action().data {
            let before = must_get_valid_record(update.original_action_address.clone())?;
            if before.entry().to_app_option::<PickupOrder>().map_err(|e| wasm_error!(e))?.is_some_and(|o| o.status == PickupStatus::Disputed) {
                return Ok(ValidateCallbackResult::Invalid("a customer reports a problem collecting an order once: the store has answered".into()));
            }
        }
    }
    let accepting = prior.status == PickupStatus::Placed && order.status == PickupStatus::MerchantConfirmed;
    if accepting && !update.within_response_window() {
        return Ok(ValidateCallbackResult::Invalid("the store's window to accept this order has passed".into()));
    }
    if let Some(reason) = check_ready_by(&update, accepting, prior.ready_by, order.ready_by) {
        return Ok(ValidateCallbackResult::Invalid(reason.into()));
    }
    let cancelled_from = (prior.status != PickupStatus::Cancelled && order.status == PickupStatus::Cancelled).then_some(match prior.status {
        PickupStatus::Placed => CancelledFrom::Placed,
        PickupStatus::ReadyForPickup => CancelledFrom::Ready,
        PickupStatus::Disputed => CancelledFrom::Disputed,
        _ => CancelledFrom::Elsewhere,
    });
    if let Some(reason) = check_cancellation(&update, cancelled_from, &prior.cancellation, &order.cancellation) {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    // The store keeping the food's price of a ready order nobody came for:
    // only past the customer's window from when it was ready, on fresh
    // proof of the time -- never on one the customer has said they can't
    // get (`Disputed`), which the store answers instead. Every other update
    // carries the proof forward unchanged.
    if cancelled_from.is_some() && order.cancellation == Some(Cancellation::NotCollected) {
        let window_ends = update.prior_written_at.as_micros().saturating_add(handshake_governance::collection_window().as_micros() as i64);
        let Some(fresh) = order.beacon.as_ref().filter(|b| prior.beacon.as_ref() != Some(*b)) else {
            return Ok(ValidateCallbackResult::Invalid("recording an order uncollected says when, with fresh proof of the time".into()));
        };
        match beacon::beacon_time(fresh) {
            Ok(at) if at.as_micros() >= window_ends => {}
            Ok(_) => return Ok(ValidateCallbackResult::Invalid("the store records an order uncollected only once the customer's window has passed".into())),
            Err(reason) => return Ok(ValidateCallbackResult::Invalid(reason.into())),
        }
    } else if order.beacon != prior.beacon {
        return Ok(ValidateCallbackResult::Invalid("only recording an order uncollected sets its proof of the time".into()));
    }

    // The store accepts an order only once it holds the customer's payment.
    if accepting {
        let order_original = resolve_original_creation(original_action_hash.clone())?;
        let Some(terms) = terms_of(&order_original)? else { return Ok(ValidateCallbackResult::Invalid("not an order".into())) };
        if let Err(reason) = check_payment(&order.customer_payment, ExpectedPayment { order_original: &order_original, terms: &terms, leg: PaymentLeg::Customer, bid: None })? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if prior.customer_payment != order.customer_payment {
        return Ok(ValidateCallbackResult::Invalid("customer_payment is set once, when the store accepts the order".into()));
    }

    let unchanged = prior.requester == order.requester
        && prior.merchant == order.merchant
        && prior.catalog_ref == order.catalog_ref
        && prior.catalog_version == order.catalog_version
        && prior.lines == order.lines
        && prior.loyalty_proof == order.loyalty_proof
        && prior.rewards == order.rewards
        && prior.order_total == order.order_total
        && prior.requested_at == order.requested_at
        && prior.kitchen_note == order.kitchen_note
        && prior.sealed_customer_name == order.sealed_customer_name
        && prior.sealed_wake == order.sealed_wake
        && prior.promo_code_ref == order.promo_code_ref;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a pickup order update may only change its status -- every other field must stay the same".into(),
        ));
    }

    Ok(ValidateCallbackResult::Valid)
}
