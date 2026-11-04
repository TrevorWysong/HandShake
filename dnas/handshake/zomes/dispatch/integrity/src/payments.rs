//! Validating direct payments' records (`dispatch_types::payments`). The
//! network can't see a card processor, so it checks what it can, which is
//! everything that decides who's owed what:
//!
//! - every record is written by the party it speaks for: a payer offers, a
//!   payee holds, acts, declines, settles and refunds;
//! - a hold is for exactly what its leg needs (`PaymentLeg::required`), and rests
//!   on an offer its payer made;
//! - a settlement captures exactly the parts its payee is owed, each on a
//!   basis that entitles them -- the ledger's rules, unchanged -- and never
//!   more than was held; a part the store passes on to a driver, exactly
//!   what the driver took;
//! - one hold per leg, one settlement per hold, and a bounded number of
//!   offers per leg, so a store's account can't be used to test cards.
//!
//! A payee recording what its processor didn't do only shortchanges itself;
//! one charging what isn't recorded leaves the record as its payer's proof.

use super::*;
use crate::basis::{basis_of, chain_check, part_bid};
use dispatch_types::direct::{entitlement, part_share, Entitlement, PaymentLeg, Part};
use dispatch_types::{Claim, PaymentAction, PaymentDeclined, PaymentHold, PaymentOffer, PaymentProfile, PaymentRefund, PaymentSettlement, Processor};
use handshake_integrity_support::chain::entries_since;
use handshake_integrity_support::limits::MAX_SEALED_BYTES;
use handshake_integrity_support::{decode, original_creation, sealed_problem, valid};

/// The most offers a payer may make for one leg of one order: room for a
/// declined card or two, and a 3-D Secure retry, without letting anyone run
/// card after card through a store's account.
pub const MAX_OFFERS_PER_LEG: usize = 6;

/// The longest a processor's id for an authorization may be.
const MAX_REFERENCE_CHARS: usize = 120;

/// A leg of an order, read from the network: the order's terms, the leg's
/// bid if it's a driver's, who pays it and who's paid, and what it needs.
pub struct LegContext {
    pub order: ActionHash,
    pub terms: OrderTerms,
    pub bid: Option<Bid>,
    pub payer: AgentPubKey,
    pub payee: AgentPubKey,
    pub required: u64,
    /// When the order was placed: nothing about paying for it is older.
    pub placed_at: Timestamp,
}

/// The order's terms, from its as-created record.
fn order_terms(order: &ActionHash) -> ExternResult<Result<(OrderTerms, Timestamp), &'static str>> {
    if &original_creation(order.clone())? != order {
        return Ok(Err("a payment names its order's original action"));
    }
    let record = must_get_valid_record(order.clone())?;
    let terms = if let Some(order) = decode::<DeliveryOrder>(&record) {
        OrderTerms::of_delivery(&order)
    } else if let Some(order) = decode::<PickupOrder>(&record) {
        OrderTerms::of_pickup(&order)
    } else {
        return Ok(Err("a payment is for an order"));
    };
    Ok(Ok((terms, record.action().timestamp())))
}

/// A driver's bid on `order`, by its action.
fn bid_on(order: &ActionHash, bid_ref: &ActionHash) -> ExternResult<Result<Bid, &'static str>> {
    let Some(bid) = decode::<Bid>(&must_get_valid_record(bid_ref.clone())?) else { return Ok(Err("a driver's leg names their bid")) };
    if &original_creation(bid.order_ref.clone())? != order {
        return Ok(Err("a driver's leg names a bid on its own order"));
    }
    Ok(Ok(bid))
}

/// `leg` of `order`, as the network prices it -- or why it can't be paid.
pub fn leg_context(order: &ActionHash, leg: &PaymentLeg) -> ExternResult<Result<LegContext, &'static str>> {
    let (terms, placed_at) = match order_terms(order)? {
        Ok(found) => found,
        Err(reason) => return Ok(Err(reason)),
    };
    let bid = match leg.bid() {
        Some(bid_ref) => match bid_on(order, bid_ref)? {
            Ok(bid) => Some(bid),
            Err(reason) => return Ok(Err(reason)),
        },
        None => None,
    };
    let Some((payer, payee)) = leg.parties(&terms, bid.as_ref()) else { return Ok(Err("that leg isn't one this order has")) };
    let Some(required) = leg.required(&terms, bid.as_ref()) else { return Ok(Err("a delivery is paid directly only with a cap on its fee")) };
    if required == 0 {
        return Ok(Err("nothing is owed on that leg: its payer would pay themselves"));
    }
    Ok(Ok(LegContext { order: order.clone(), terms, bid, payer, payee, required, placed_at }))
}

fn entry_type(unit: UnitEntryTypes) -> ExternResult<ScopedEntryDefIndex> {
    ScopedEntryDefIndex::try_from(unit)
}

/// Each `T` its author wrote from `chain_top` back to `since`.
fn written_since<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(author: &AgentPubKey, chain_top: &ActionHash, since: Timestamp, unit: UnitEntryTypes) -> ExternResult<Vec<T>> {
    Ok(entries_since(author, chain_top, since, &[entry_type(unit)?])?.into_iter().filter_map(|bytes| T::try_from(bytes).ok()).collect())
}

/// Whether `text` is an id a processor would issue: a short run of letters,
/// digits, `_` and `-`.
fn processor_id(text: &str, max: usize) -> bool {
    !text.is_empty() && text.len() <= max && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The offer an action, decline or hold answers, read with its leg.
fn offer_of(offer_ref: &ActionHash) -> ExternResult<Result<(PaymentOffer, AgentPubKey, LegContext), &'static str>> {
    let record = must_get_valid_record(offer_ref.clone())?;
    let Some(offer) = decode::<PaymentOffer>(&record) else { return Ok(Err("that isn't a payment offer")) };
    let context = match leg_context(&offer.order, &offer.leg)? {
        Ok(context) => context,
        Err(reason) => return Ok(Err(reason)),
    };
    Ok(Ok((offer, record.action().author().clone(), context)))
}

pub fn validate_profile(profile: &PaymentProfile) -> ExternResult<ValidateCallbackResult> {
    if profile.live != handshake_governance::live_payments() {
        return invalid(if profile.live { "this network's payments are tests: connect a processor account in its test mode" } else { "this network's payments are real: connect a live processor account" });
    }
    if !processor_id(&profile.public_key, 200) {
        return invalid("a processor's public key is its letters, digits, '_' and '-'");
    }
    if profile.processor == Processor::Test && (profile.live || handshake_governance::live_payments()) {
        return invalid("the test processor moves no money: it's for test networks only");
    }
    let account_ok = match profile.processor {
        Processor::Stripe | Processor::PayPal | Processor::Test => profile.account.is_empty(),
        Processor::Square | Processor::Clover => processor_id(&profile.account, 64),
    };
    if !account_ok {
        return invalid("a Square location or Clover merchant id is its letters and digits; Stripe and PayPal name none");
    }
    if !(profile.country.is_empty() || (profile.country.len() == 2 && profile.country.bytes().all(|b| b.is_ascii_uppercase()))) {
        return invalid("a payment account's country is two capital letters (ISO 3166), or none");
    }
    if profile.processor == Processor::Square && profile.country.is_empty() {
        return invalid("a Square account names its country, for wallets' payment sheets");
    }
    // A Stripe publishable key says which mode it's for -- and a secret key
    // must never be published.
    if profile.processor == Processor::Stripe && !profile.public_key.starts_with(if profile.live { "pk_live_" } else { "pk_test_" }) {
        return invalid(if profile.live { "a live Stripe account's publishable key starts pk_live_" } else { "a test Stripe account's publishable key starts pk_test_" });
    }
    valid()
}

pub fn validate_offer(offer: &PaymentOffer, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("a payment record can't open a chain") };
    let context = match leg_context(&offer.order, &offer.leg)? {
        Ok(context) => context,
        Err(reason) => return invalid(reason),
    };
    if author != &context.payer {
        return invalid("a payment is offered by whoever pays that leg");
    }
    if let Some(sealed) = &offer.sealed_token {
        if let Some(problem) = sealed_problem("sealed_token", sealed, MAX_SEALED_BYTES) {
            return Ok(ValidateCallbackResult::Invalid(problem));
        }
    } else if offer.save {
        return invalid("only a new card can be saved");
    }
    if let Some(action_ref) = &offer.resumes {
        let Some(action) = decode::<PaymentAction>(&must_get_valid_record(action_ref.clone())?) else { return invalid("an offer resumes a payment action") };
        let Some(earlier) = decode::<PaymentOffer>(&must_get_valid_record(action.offer.clone())?) else { return invalid("an offer resumes a payment action") };
        if earlier.order != offer.order || earlier.leg != offer.leg {
            return invalid("an offer resumes an action on its own leg");
        }
    }
    let earlier: Vec<PaymentOffer> = written_since(author, prev_action, context.placed_at, UnitEntryTypes::PaymentOffer)?;
    let same_leg = earlier.iter().filter(|o| o.order == offer.order && o.leg == offer.leg).count();
    require(same_leg < MAX_OFFERS_PER_LEG, "too many payment attempts on this order -- try again with a new one")
}

pub fn validate_hold(hold: &PaymentHold, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("a payment record can't open a chain") };
    let (offer, _, context) = match offer_of(&hold.offer)? {
        Ok(found) => found,
        Err(reason) => return invalid(reason),
    };
    if author != &context.payee {
        return invalid("a payment is held by its payee");
    }
    if hold.amount != context.required {
        return invalid("a hold is for exactly what its leg needs");
    }
    if !processor_id(&hold.reference, MAX_REFERENCE_CHARS) {
        return invalid("a hold's reference is its processor's id: letters, digits, '_' and '-'");
    }
    // One hold per leg: every earlier one is on the payee's own chain.
    for earlier in written_since::<PaymentHold>(author, prev_action, context.placed_at, UnitEntryTypes::PaymentHold)? {
        if let Ok((o, _, _)) = offer_of(&earlier.offer)? {
            if o.order == offer.order && o.leg == offer.leg {
                return invalid("that leg is already held");
            }
        }
    }
    valid()
}

pub fn validate_action(action: &PaymentAction, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let context = match offer_of(&action.offer)? {
        Ok((_, _, context)) => context,
        Err(reason) => return invalid(reason),
    };
    if author != &context.payee {
        return invalid("only an offer's payee asks its payer for more");
    }
    match sealed_problem("sealed", &action.sealed, MAX_SEALED_BYTES) {
        Some(problem) => Ok(ValidateCallbackResult::Invalid(problem)),
        None => valid(),
    }
}

pub fn validate_declined(declined: &PaymentDeclined, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let context = match offer_of(&declined.offer)? {
        Ok((_, _, context)) => context,
        Err(reason) => return invalid(reason),
    };
    require(author == &context.payee, "only an offer's payee declines it")
}

/// The order a payment record is about (its original action) -- `None` if
/// the record isn't one.
pub fn order_of_payment(record: &Record) -> ExternResult<Option<ActionHash>> {
    let offer_ref = if let Some(offer) = decode::<PaymentOffer>(record) {
        return Ok(Some(offer.order));
    } else if let Some(hold) = decode::<PaymentHold>(record) {
        hold.offer
    } else if let Some(action) = decode::<PaymentAction>(record) {
        action.offer
    } else if let Some(declined) = decode::<PaymentDeclined>(record) {
        declined.offer
    } else if let Some(settlement) = decode::<PaymentSettlement>(record) {
        return order_of_payment(&must_get_valid_record(settlement.hold)?);
    } else if let Some(refund) = decode::<PaymentRefund>(record) {
        return order_of_payment(&must_get_valid_record(refund.settlement)?);
    } else {
        return Ok(None);
    };
    Ok(decode::<PaymentOffer>(&must_get_valid_record(offer_ref)?).map(|offer| offer.order))
}

/// A hold, by its payee, with its offer and leg.
fn hold_of(hold_ref: &ActionHash) -> ExternResult<Result<(PaymentHold, AgentPubKey, PaymentOffer, LegContext), &'static str>> {
    let record = must_get_valid_record(hold_ref.clone())?;
    let Some(hold) = decode::<PaymentHold>(&record) else { return Ok(Err("that isn't a payment hold")) };
    let (offer, _, context) = match offer_of(&hold.offer)? {
        Ok(found) => found,
        Err(reason) => return Ok(Err(reason)),
    };
    Ok(Ok((hold, record.action().author().clone(), offer, context)))
}

/// What one claim takes, or why it can't. `author` is the payee, its chain
/// at `chain_top`.
fn claim_amount(claim: &Claim, leg: &PaymentLeg, context: &LegContext, author: &AgentPubKey, chain_top: &ActionHash) -> ExternResult<Result<u64, &'static str>> {
    if !leg.includes(&claim.part) {
        return Ok(Err("a settlement claims only its own leg's parts"));
    }
    let bid = match part_bid(&claim.part) {
        Some(bid_ref) => match bid_on(&context.order, bid_ref)? {
            Ok(bid) => Some(bid),
            Err(reason) => return Ok(Err(reason)),
        },
        None => None,
    };
    let Some((_, amount)) = part_share(&context.terms, &claim.part, bid.as_ref()) else { return Ok(Err("this order has no such part")) };
    // A driver's pay the store passes on: exactly what the driver took.
    if *leg == PaymentLeg::Customer && matches!(claim.part.purpose, HoldPurpose::DriverPay { .. }) {
        let Some(via) = &claim.via else { return Ok(Err("the store takes a driver's pay only as the driver takes it, citing their settlement")) };
        let record = must_get_valid_record(via.clone())?;
        let Some(theirs) = decode::<PaymentSettlement>(&record) else { return Ok(Err("a pass-on cites the driver's settlement")) };
        let (_, driver, offer, _) = match hold_of(&theirs.hold)? {
            Ok(found) => found,
            Err(reason) => return Ok(Err(reason)),
        };
        let their_leg = part_bid(&claim.part).map(|bid| PaymentLeg::DriverPay { bid: bid.clone() });
        let by_its_driver = bid.as_ref().is_some_and(|bid| bid.bidder == driver);
        if offer.order != context.order || Some(&offer.leg) != their_leg.as_ref() || !by_its_driver {
            return Ok(Err("a pass-on cites the settlement of that part's own driver"));
        }
        return Ok(theirs.claims.iter().any(|c| c.part == claim.part).then_some(amount).ok_or("the driver didn't take that part"));
    }
    if claim.via.is_some() {
        return Ok(Err("only a driver's pay is passed on"));
    }
    let delivery = context.terms.delivery;
    let basis = match basis_of(&claim.basis, &context.order, &context.terms.merchant, delivery, &claim.part)? {
        Ok(basis) => basis,
        Err(reason) => return Ok(Err(reason)),
    };
    Ok(match entitlement(&claim.part, amount, &basis) {
        Entitlement::Takes(n) => Ok(n),
        Entitlement::TakesIf(check, n) => {
            if chain_check(check, &claim.basis, &context.order, &claim.part, author, chain_top)? {
                Ok(n)
            } else {
                Err("what the customer knew when they cancelled doesn't entitle that")
            }
        }
        Entitlement::No => Err("that isn't grounds for taking that part"),
    })
}

pub fn validate_settlement(settlement: &PaymentSettlement, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("a payment record can't open a chain") };
    let (hold, holder, offer, context) = match hold_of(&settlement.hold)? {
        Ok(found) => found,
        Err(reason) => return invalid(reason),
    };
    if author != &holder {
        return invalid("a hold is settled by whoever held it");
    }
    let mut parts: Vec<&Part> = Vec::new();
    let mut total: u64 = 0;
    for claim in &settlement.claims {
        if parts.contains(&&claim.part) {
            return invalid("a settlement claims each part once");
        }
        parts.push(&claim.part);
        match claim_amount(claim, &offer.leg, &context, author, prev_action)? {
            Ok(amount) => total += amount,
            Err(reason) => return invalid(reason),
        }
    }
    if settlement.captured != total || total > hold.amount {
        return invalid("a settlement captures exactly what it claims, within what was held");
    }
    // One settlement per hold.
    let earlier: Vec<PaymentSettlement> = written_since(author, prev_action, context.placed_at, UnitEntryTypes::PaymentSettlement)?;
    require(!earlier.iter().any(|s| s.hold == settlement.hold), "that hold is already settled")
}

pub fn validate_refund(refund: &PaymentRefund, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("a payment record can't open a chain") };
    let record = must_get_valid_record(refund.settlement.clone())?;
    let Some(settlement) = decode::<PaymentSettlement>(&record) else { return invalid("a refund is from a settlement") };
    if record.action().author() != author {
        return invalid("a refund is made by whoever captured the payment");
    }
    let (_, _, offer, context) = match hold_of(&settlement.hold)? {
        Ok(found) => found,
        Err(reason) => return invalid(reason),
    };
    if offer.leg != PaymentLeg::Customer {
        return invalid("a ruling is refunded from the customer's payment");
    }
    let Some(ruling) = decode::<Ruling>(&must_get_valid_record(refund.ruling.clone())?) else { return invalid("a refund pays a ruling") };
    let Some(appeal) = decode::<Appeal>(&must_get_valid_record(ruling.appeal.clone())?) else { return invalid("a ruling is on an appeal") };
    if appeal.order != context.order {
        return invalid("a refund pays a ruling on its own order");
    }
    let earlier: Vec<PaymentRefund> = written_since(author, prev_action, context.placed_at, UnitEntryTypes::PaymentRefund)?;
    let for_ruling: u64 = earlier.iter().filter(|r| r.ruling == refund.ruling).map(|r| r.amount).sum();
    let from_settlement: u64 = earlier.iter().filter(|r| r.settlement == refund.settlement).map(|r| r.amount).sum();
    let fits = refund.amount > 0 && for_ruling + refund.amount <= ruling.award && from_settlement + refund.amount <= settlement.captured;
    require(fits, "a refund pays what the ruling awards, from what was captured, once")
}
