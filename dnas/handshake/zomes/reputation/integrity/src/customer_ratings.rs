//! Customers rated (docs/REPUTATION.md, phase 4): the store and the driver
//! of a completed order each give its customer a thumbs up or down -- a
//! thumbs-down with a reason from a fixed list, never about tipping (a tip
//! is set before a driver bids). Read as a share of thumbs-up over the
//! customer's recent rated orders, from raters who don't rate most
//! customers down; validation holds who may rate, on what, and how often.

use crate::*;

/// Why a customer was rated down: a fixed list, so nothing free-written
/// about anyone is published.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustomerReason {
    RudeOrAbusive,
    /// Not there, or not answering, at the drop-off or the counter.
    Unreachable,
    Unsafe,
    /// Wrong or missing address details.
    AddressDetails,
    /// Asked to take the order, or pay, off the app.
    OffApp,
    Other,
}

/// The store's or the driver's rating of an order's customer.
#[hdk_entry_helper]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct CustomerRating {
    /// The order's original action.
    pub order_ref: ActionHash,
    /// The version showing it completed -- delivered, collected or picked
    /// up -- and, for a delivery, its driver.
    pub completed: ActionHash,
    pub customer: AgentPubKey,
    pub up: bool,
    /// Why, for a thumbs-down; none for a thumbs-up.
    pub reason: Option<CustomerReason>,
    /// The store, by its catalog, when its owner rates as the order's store;
    /// none from its driver. What tells a reader which kind of rater to
    /// weigh, from the tag alone.
    pub store: Option<ActionHash>,
}

/// A `CustomerToRating` link's tag: up or down, its reason's place, the
/// order, and the store when the store rated -- what a customer's score is
/// counted from in one read.
pub fn customer_rating_tag(rating: &CustomerRating) -> LinkTag {
    let mut bytes = vec![u8::from(rating.up), rating.reason.map_or(u8::MAX, |r| r as u8)];
    bytes.extend_from_slice(rating.order_ref.get_raw_39());
    if let Some(store) = &rating.store {
        bytes.extend_from_slice(store.get_raw_39());
    }
    LinkTag::new(bytes)
}

/// A `RaterToRating` link's tag: the order first -- so a rater finds their
/// own rating on an order by its prefix -- then up or down and its reason's
/// place, which is what tells a rater who rates most customers down.
pub fn rater_tag(rating: &CustomerRating) -> LinkTag {
    let mut bytes = rating.order_ref.get_raw_39().to_vec();
    bytes.extend_from_slice(&[u8::from(rating.up), rating.reason.map_or(u8::MAX, |r| r as u8)]);
    LinkTag::new(bytes)
}

/// Only the order's store, or the driver who delivered it, rates its
/// customer -- once each, on the order completed and within
/// `customer_rating_days` of it; a thumbs-down with a reason, a thumbs-up
/// with none.
pub(crate) fn validate_customer_rating(rating: &CustomerRating, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if rating.up == rating.reason.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a thumbs-down gives a reason, a thumbs-up none".into()));
    }
    if original_creation(rating.order_ref.clone())? != rating.order_ref || original_creation(rating.completed.clone())? != rating.order_ref {
        return Ok(ValidateCallbackResult::Invalid("a rating cites its order and a version of it".into()));
    }
    let completed = must_get_valid_record(rating.completed.clone())?;
    let Some(order) = Parties::of(&completed)? else {
        return Ok(ValidateCallbackResult::Invalid("a rating cites an order".into()));
    };
    if !order.completed || rating.customer != order.requester {
        return Ok(ValidateCallbackResult::Invalid("a customer is rated on an order they completed".into()));
    }
    if author != &order.merchant && order.driver.as_ref() != Some(author) {
        return Ok(ValidateCallbackResult::Invalid("only the order's store, or its driver, rates its customer".into()));
    }
    if author == &rating.customer {
        return Ok(ValidateCallbackResult::Invalid("nobody rates themselves".into()));
    }
    // The store's owner rates as the store, even delivering it themselves.
    if rating.store != (author == &order.merchant).then(|| order.catalog_ref.clone()) {
        return Ok(ValidateCallbackResult::Invalid("a store's rating names its store, a driver's none".into()));
    }
    let deadline = completed.action().timestamp().as_micros().saturating_add(i64::from(handshake_governance::customer_rating_days()) * 86_400_000_000);
    if at.as_micros() > deadline {
        return Ok(ValidateCallbackResult::Invalid("a customer is rated within days of their order completing".into()));
    }
    let Some(prev) = prev_action else { return Ok(ValidateCallbackResult::Invalid("a rating can't open a chain".into())) };
    let placed = must_get_action(rating.order_ref.clone())?.hashed.content.header.timestamp;
    if at < placed {
        return Ok(ValidateCallbackResult::Invalid("a rating comes after its order".into()));
    }
    let again = handshake_integrity_support::chain::wrote_since::<CustomerRating>(author, prev, placed, UnitEntryTypes::CustomerRating.try_into()?, |r| r.order_ref == rating.order_ref)?;
    if again {
        return Ok(ValidateCallbackResult::Invalid("a customer is rated once per order by each".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}
