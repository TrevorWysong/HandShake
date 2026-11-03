//! The money behind each step of an order: an order moves on only once the
//! step's payee holds what that step is paid with (see `dispatch_types::
//! direct`), and the step's update cites the hold. `payments` validates the
//! hold itself -- its offer, its payee, its amount; this checks that a step
//! cites the right one.
//!
//! - The store accepting cites its hold of the customer's payment.
//! - The driver committing cites the store's hold of their collateral --
//!   before the store cooks, so a driver who leaves it cooked has covered it
//!   -- and their own hold of their pay from the store, before they set
//!   off, so whatever they're owed for the trip is held.

use super::*;
use dispatch_types::direct::PaymentLeg;
use dispatch_types::{OrderTerms, PaymentHold, PaymentOffer};
use handshake_integrity_support::decode;

/// One step's payment: the order, its terms, the leg the step needs, and
/// the leg's bid if it's a driver's.
pub(crate) struct ExpectedPayment<'a> {
    pub order_original: &'a ActionHash,
    pub terms: &'a OrderTerms,
    pub leg: PaymentLeg,
    pub bid: Option<&'a Bid>,
}

/// A step that needs a payment must cite exactly its leg's hold, by that
/// leg's payee, for what it needs; a step for which nothing is owed (a
/// store ordering from itself) cites none.
pub(crate) fn check_payment(cited: &Option<ActionHash>, expected: ExpectedPayment<'_>) -> ExternResult<Result<(), String>> {
    let Some((_, payee)) = expected.leg.parties(expected.terms, expected.bid) else {
        return Ok(Err("that payment doesn't fit this order".into()));
    };
    let Some(required) = expected.leg.required(expected.terms, expected.bid) else {
        return Ok(Err("a delivery is paid for directly only with a cap on its fee".into()));
    };
    let Some(hold_ref) = cited else {
        return Ok(if required == 0 { Ok(()) } else { Err(format!("this step needs its {:?} payment, held first", expected.leg)) });
    };
    if required == 0 {
        return Ok(Err("nothing is owed for this step, so it cites no payment".into()));
    }
    let record = must_get_valid_record(hold_ref.clone())?;
    let Some(hold) = decode::<PaymentHold>(&record) else { return Ok(Err("a step's payment must be a payment hold".into())) };
    let Some(offer) = decode::<PaymentOffer>(&must_get_valid_record(hold.offer.clone())?) else { return Ok(Err("a payment hold rests on an offer".into())) };
    let matches = &offer.order == expected.order_original && offer.leg == expected.leg && record.action().author() == &payee && hold.amount == required;
    Ok(if matches { Ok(()) } else { Err("a step must cite its own order's payment for this step, held by whoever it pays".into()) })
}

/// The order's terms, from its as-created record.
pub(crate) fn terms_of(order_original: &ActionHash) -> ExternResult<Option<OrderTerms>> {
    let record = must_get_valid_record(order_original.clone())?;
    if let Some(order) = decode::<DeliveryOrder>(&record) {
        return Ok(Some(OrderTerms::of_delivery(&order)));
    }
    Ok(decode::<PickupOrder>(&record).map(|order| OrderTerms::of_pickup(&order)))
}
