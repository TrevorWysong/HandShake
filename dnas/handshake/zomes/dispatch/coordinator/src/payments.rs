//! Paying for orders directly: the calls a payer's app makes to offer a
//! card, and the calls a payee's payment agent (`payments/`, beside the
//! conductor, holding the payee's processor key) makes to find what it
//! should do and record what it did. The records and their rules are
//! `dispatch_types::payments` and `dispatch_integrity::payments`.
//!
//! Every amount comes from the network, never from the app: the agent asks
//! `payments_due` what to authorize, capture or refund, and each record it
//! writes back is validated against the order. An app that only *asks*
//! can't move money -- so neither can anything injected into its page.

use crate::settlement::{holds_on, settlement_due, settlements_on, DueClaim};
use dispatch_integrity::payments::{leg_context, LegContext};
use dispatch_integrity::*;
use handshake_coordinator_support::{decode_or, guest, open, original_action_of, seal};
use hdk::prelude::*;

/// The longest a processor's single-use card token may be.
const MAX_TOKEN_CHARS: usize = 512;
/// The longest an action a payer completes (3-D Secure's) may be.
const MAX_ACTION_CHARS: usize = 2_048;

/// A card, as a payer's app hands it over.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PaymentInput {
    /// A single-use token from the payee's processor's card form; `None` for
    /// the card the payer saved with this payee.
    pub token: Option<String>,
    /// Let the payee keep this card for the payer's later payments to them.
    #[serde(default)]
    pub save: bool,
}

fn me() -> ExternResult<AgentPubKey> {
    Ok(agent_info()?.agent_initial_pubkey)
}

/// A leg of an order, as the network prices it -- or why it can't be paid.
fn leg(order: &ActionHash, leg: &PaymentLeg) -> ExternResult<LegContext> {
    leg_context(order, leg)?.map_err(guest)
}

/// Offers the caller's card for `leg` of `order` (its original action) to
/// the leg's payee: the token sealed to them alone, linked under the order,
/// and the payee told. Their payment agent holds it, or asks for more, or
/// declines it.
pub(crate) fn offer(order: &ActionHash, leg_of: PaymentLeg, input: PaymentInput) -> ExternResult<ActionHash> {
    offer_resuming(order, leg_of, input, None)
}

fn offer_resuming(order: &ActionHash, leg_of: PaymentLeg, input: PaymentInput, resumes: Option<ActionHash>) -> ExternResult<ActionHash> {
    let context = leg(order, &leg_of)?;
    if context.payer != me()? {
        return Err(guest("Only whoever pays that part of the order offers a card for it."));
    }
    let sealed_token = match &input.token {
        Some(token) if token.is_empty() || token.len() > MAX_TOKEN_CHARS => return Err(guest("That card didn't come through. Try entering it again.")),
        Some(token) => Some(seal(&context.payee, token)?),
        None => None,
    };
    let offer = PaymentOffer { order: order.clone(), leg: leg_of, sealed_token, save: input.save && input.token.is_some(), resumes };
    let hash = create_entry(&EntryTypes::PaymentOffer(offer))?;
    create_link(order.clone(), hash.clone(), LinkTypes::OrderToPayment, ())?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: order.clone() }, vec![context.payee]);
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct OfferPaymentInput {
    /// The order (its original action, or any version of it).
    pub order: ActionHash,
    pub leg: PaymentLeg,
    pub payment: PaymentInput,
    /// The `PaymentAction` this answers, once the payer has done it.
    #[serde(default)]
    pub resumes: Option<ActionHash>,
}

/// Offers a card for a leg of an order -- for a payer's screen: a declined
/// card's retry, a 3-D Secure challenge done, the store paying its driver,
/// a driver's collateral.
#[hdk_extern]
pub fn offer_payment(input: OfferPaymentInput) -> ExternResult<ActionHash> {
    let order = original_action_of(input.order)?;
    offer_resuming(&order, input.leg, input.payment, input.resumes)
}

/// How far back a payer's app looks for a card they saved with a payee.
const SAVED_CARD_DAYS: i64 = 365;

/// Whether the caller saved a card with `payee`: offered one with `save`,
/// for a leg `payee` was paid on, and `payee` held it.
fn saved_with(payee: &AgentPubKey) -> ExternResult<bool> {
    let since = Timestamp::from_micros(sys_time()?.as_micros() - SAVED_CARD_DAYS * 86_400_000_000);
    let offers = handshake_coordinator_support::chain::mine(&[EntryType::try_from(UnitEntryTypes::PaymentOffer)?]).creates().since(since).records()?;
    for record in offers {
        let Some(offer) = decode_or::<PaymentOffer>(&record).filter(|o| o.save) else { continue };
        let held = holds_on(&offer.order)?.into_iter().any(|(_, author, hold, _)| &author == payee && &hold.offer == record.action_address());
        if held {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The caller's app offering their saved card for `leg` of `order`, by
/// itself -- only where they saved one with that leg's payee, and only once
/// a leg: a decline waits for them.
pub(crate) fn offer_saved(order: &ActionHash, leg_of: PaymentLeg) -> ExternResult<bool> {
    let Ok(context) = leg_context(order, &leg_of)? else { return Ok(false) };
    if context.payer != me()? || hold_for(order, &leg_of, &context.payee)?.is_some() {
        return Ok(false);
    }
    let me = me()?;
    let offered = get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToPayment)?.author(me), GetStrategy::Local)?.into_iter().any(|link| {
        link.target.into_action_hash().and_then(|h| get(h, GetOptions::local()).ok().flatten()).and_then(|r| decode_or::<PaymentOffer>(&r)).is_some_and(|o| o.leg == leg_of)
    });
    if offered || !saved_with(&context.payee)? {
        return Ok(false);
    }
    offer(order, leg_of, PaymentInput { token: None, save: false })?;
    Ok(true)
}

/// The hold a step cites: `payee`'s on `leg` of `order` -- or none, where
/// the leg needs nothing (a store ordering from itself); an error naming
/// `missing` where it needs one that isn't held yet.
pub(crate) fn step_payment(order: &ActionHash, leg_of: &PaymentLeg, payee: &AgentPubKey, missing: &str) -> ExternResult<Option<ActionHash>> {
    match leg_context(order, leg_of)? {
        Err(_) => Ok(None),
        Ok(_) => hold_for(order, leg_of, payee)?.map(Some).ok_or(guest(missing)),
    }
}

/// `payee`'s hold of `leg` on `order`, if they've made it.
pub(crate) fn hold_for(order: &ActionHash, leg_of: &PaymentLeg, payee: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    Ok(holds_on(order)?.into_iter().find(|(_, author, _, offer)| author == payee && &offer.leg == leg_of).map(|(hash, ..)| hash))
}

// --- how a payee is paid ---

/// The caller's own profile link, if they've published one.
fn my_profile_link() -> ExternResult<Option<Link>> {
    let me = me()?;
    Ok(get_links(LinkQuery::try_new(me.clone(), LinkTypes::AgentToPaymentProfile)?.author(me), GetStrategy::Local)?.into_iter().last())
}

/// Publishes how the caller is paid -- their processor, and what a payer's
/// app needs to show its card form. Never a secret: the payment agent keeps
/// the key, and publishes this once it has checked it.
#[hdk_extern]
pub fn set_payment_profile(profile: PaymentProfile) -> ExternResult<ActionHash> {
    if let Some(link) = my_profile_link()? {
        let current = link.target.into_action_hash().ok_or(guest("couldn't read your payment profile"))?;
        let original = original_action_of(current.clone())?;
        let latest = handshake_coordinator_support::resolve_latest(original)?;
        if decode_or::<PaymentProfile>(&latest).as_ref() == Some(&profile) {
            return Ok(latest.action_address().clone());
        }
        return update_entry(latest.action_address().clone(), &EntryTypes::PaymentProfile(profile));
    }
    let hash = create_entry(&EntryTypes::PaymentProfile(profile))?;
    create_link(me()?, hash.clone(), LinkTypes::AgentToPaymentProfile, ())?;
    Ok(hash)
}

/// Stops the caller being paid by card: payers' apps no longer find a
/// profile for them. (A payment already held still settles.)
#[hdk_extern]
pub fn clear_payment_profile(_: ()) -> ExternResult<()> {
    let me = me()?;
    for link in get_links(LinkQuery::try_new(me.clone(), LinkTypes::AgentToPaymentProfile)?.author(me), GetStrategy::Local)? {
        delete_link(link.create_link_hash, GetOptions::default())?;
    }
    Ok(())
}

/// How `agent` is paid, as they last published it -- `None` if they can't
/// be paid by card.
#[hdk_extern]
pub fn payment_profile_of(agent: AgentPubKey) -> ExternResult<Option<PaymentProfile>> {
    let links = get_links(LinkQuery::try_new(agent.clone(), LinkTypes::AgentToPaymentProfile)?.author(agent), GetStrategy::default())?;
    let Some(target) = links.into_iter().last().and_then(|l| l.target.into_action_hash()) else { return Ok(None) };
    let latest = handshake_coordinator_support::resolve_latest(original_action_of(target)?)?;
    Ok(decode_or::<PaymentProfile>(&latest))
}

// --- what a payee's agent should do ---

/// One thing a payee's payment agent should do on its processor -- exact,
/// from the network.
#[derive(Serialize, Deserialize, Debug)]
pub enum PaymentDue {
    /// Authorize an offer, with manual capture, for exactly `amount`.
    Authorize {
        offer: ActionHash,
        order: ActionHash,
        leg: PaymentLeg,
        amount: u64,
        payer: AgentPubKey,
        /// The single-use token, opened -- `None` to use the card the payer
        /// saved with the payee.
        token: Option<String>,
        /// The payer lets the payee keep this card.
        save: bool,
        /// The action this offer answers: resume the authorization that
        /// asked for it.
        resumes: Option<ActionHash>,
        /// The store, when the order takes its deal for first orders: one
        /// card each, which the agent checks by its processor's card
        /// fingerprint (on-chain, a first order is one per account).
        newcomer_deal: Option<ActionHash>,
    },
    /// Capture `captured` of a hold -- releasing the rest; nothing, to
    /// release it all -- and record the claims.
    Settle { hold: ActionHash, reference: String, held: u64, captured: u64, claims: Vec<DueClaim> },
    /// Refund an arbiter's award from a captured payment.
    Refund { settlement: ActionHash, reference: String, ruling: ActionHash, amount: u64 },
}

/// How many days of orders the agent looks through: a card authorization
/// lasts about seven, so nothing older can still be authorized or captured.
const DUE_DAYS: i64 = 8;

/// What the caller, as a payee, should do now -- authorize, settle,
/// refund -- across every recent order they're paid on.
#[hdk_extern]
pub fn payments_due(_: ()) -> ExternResult<Vec<PaymentDue>> {
    let me = me()?;
    let mut due = Vec::new();
    for order in crate::settlement::candidates(DUE_DAYS)? {
        due.extend(due_on(&order, &me).unwrap_or_default());
    }
    due.extend(refunds_due(&me)?);
    Ok(due)
}

/// What the caller should do on one order.
fn due_on(order: &ActionHash, me: &AgentPubKey) -> ExternResult<Vec<PaymentDue>> {
    let mut due = Vec::new();
    let mut offers: Vec<(Timestamp, ActionHash, AgentPubKey, PaymentOffer)> = Vec::new();
    let mut answered: Vec<ActionHash> = Vec::new();
    let mut held_legs: Vec<PaymentLeg> = Vec::new();
    let mut settled: Vec<ActionHash> = Vec::new();
    let mut my_holds: Vec<(ActionHash, PaymentHold)> = Vec::new();
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToPayment)?, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        let author = record.action().author().clone();
        if let Some(offer) = decode_or::<PaymentOffer>(&record) {
            offers.push((record.action().timestamp(), hash, author, offer));
        } else if author != *me {
            continue;
        } else if let Some(hold) = decode_or::<PaymentHold>(&record) {
            if let Some(offer) = get(hold.offer.clone(), GetOptions::default())?.and_then(|r| decode_or::<PaymentOffer>(&r)) {
                held_legs.push(offer.leg);
            }
            answered.push(hold.offer.clone());
            my_holds.push((hash, hold));
        } else if let Some(action) = decode_or::<PaymentAction>(&record) {
            answered.push(action.offer);
        } else if let Some(declined) = decode_or::<PaymentDeclined>(&record) {
            answered.push(declined.offer);
        } else if let Some(settlement) = decode_or::<PaymentSettlement>(&record) {
            settled.push(settlement.hold);
        }
    }
    // Only what the order still needs: nothing once it's over, and a
    // driver's legs only for the driver it has -- so nobody can run cards
    // through a store's account by bidding on orders they'll never carry.
    // An order not yet seen here has nothing to authorize, but its holds
    // still settle.
    let latest = handshake_coordinator_support::resolve_latest(order.clone()).ok();
    let (ongoing, accepted_bid) = match latest.as_ref().map(|r| (decode_or::<DeliveryOrder>(r), decode_or::<PickupOrder>(r))) {
        Some((Some(o), _)) => (!o.status.is_terminal(), o.accepted_bid),
        Some((None, Some(o))) => (!o.status.is_terminal(), None),
        _ => (false, None),
    };
    let wanted = |leg: &PaymentLeg| ongoing && leg.bid().is_none_or(|bid| accepted_bid.as_ref() == Some(bid));
    // The newest unanswered offer on each leg I'm paid on, while it isn't
    // held.
    offers.sort_by_key(|(at, ..)| *at);
    let mut seen: Vec<PaymentLeg> = Vec::new();
    for (_, offer_ref, payer, offer) in offers.into_iter().rev() {
        if seen.contains(&offer.leg) || held_legs.contains(&offer.leg) || answered.contains(&offer_ref) || !wanted(&offer.leg) {
            continue;
        }
        let Ok(Ok(context)) = leg_context(order, &offer.leg) else { continue };
        if &context.payee != me || context.payer != payer {
            continue;
        }
        seen.push(offer.leg.clone());
        let token = match &offer.sealed_token {
            Some(sealed) => match open::<String>(&payer, sealed)? {
                Some(token) => Some(token),
                None => continue,
            },
            None => None,
        };
        let newcomer_deal = if offer.leg == PaymentLeg::Customer { newcomer_deal(order)? } else { None };
        due.push(PaymentDue::Authorize { offer: offer_ref, order: order.clone(), leg: offer.leg, amount: context.required, payer, token, save: offer.save, resumes: offer.resumes, newcomer_deal });
    }
    // Each of my holds, once nothing can change what it's owed.
    for (hold_ref, hold) in my_holds {
        if settled.contains(&hold_ref) {
            continue;
        }
        if let Some(claims) = settlement_due(&hold_ref)? {
            let captured = claims.iter().map(|c| c.amount).sum();
            due.push(PaymentDue::Settle { hold: hold_ref, reference: hold.reference, held: hold.amount, captured, claims });
        }
    }
    Ok(due)
}

/// The store, when `order` cites a version of a promo for first orders
/// there.
fn newcomer_deal(order: &ActionHash) -> ExternResult<Option<ActionHash>> {
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    let (promo, store) = match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => (o.promo_code_ref, o.catalog_ref),
        (None, Some(o)) => (o.promo_code_ref, o.catalog_ref),
        _ => return Ok(None),
    };
    let Some(promo) = promo else { return Ok(None) };
    let first_only = get(promo, GetOptions::default())?.and_then(|r| decode_or::<catalog_types::PromoCode>(&r)).is_some_and(|p| p.limits.first_order_only);
    Ok(first_only.then_some(store))
}

/// Awards against the caller's stores not yet refunded in full.
fn refunds_due(me: &AgentPubKey) -> ExternResult<Vec<PaymentDue>> {
    let mut due = Vec::new();
    for link in get_links(LinkQuery::try_new(me.clone(), LinkTypes::StoreOwnerToRuling)?, GetStrategy::default())? {
        let Some(ruling_ref) = link.target.into_action_hash() else { continue };
        let Some(ruling) = get(ruling_ref.clone(), GetOptions::default())?.and_then(|r| decode_or::<Ruling>(&r)) else { continue };
        if ruling.award == 0 {
            continue;
        }
        let Some(appeal) = get(ruling.appeal.clone(), GetOptions::default())?.and_then(|r| decode_or::<Appeal>(&r)) else { continue };
        // The store's settlement of the customer's payment, and what it's
        // refunded from it.
        let holds = holds_on(&appeal.order)?;
        let Some((hold_ref, _, hold, _)) = holds.into_iter().find(|(_, author, _, offer)| author == me && offer.leg == PaymentLeg::Customer) else { continue };
        let Some((settlement_ref, _, settlement)) = settlements_on(&appeal.order)?.into_iter().find(|(_, author, s)| author == me && s.hold == hold_ref) else { continue };
        let refunds: Vec<PaymentRefund> = refunds_on(&appeal.order, me)?;
        let paid: u64 = refunds.iter().filter(|r| r.ruling == ruling_ref).map(|r| r.amount).sum();
        let from_settlement: u64 = refunds.iter().filter(|r| r.settlement == settlement_ref).map(|r| r.amount).sum();
        let amount = ruling.award.saturating_sub(paid).min(settlement.captured.saturating_sub(from_settlement));
        if amount > 0 {
            due.push(PaymentDue::Refund { settlement: settlement_ref, reference: hold.reference, ruling: ruling_ref, amount });
        }
    }
    Ok(due)
}

/// What `payee` charged of their hold `hold_ref` on `order` -- its
/// settlement's capture, less what they've refunded from it for an
/// arbiter's award -- or `None` while it isn't settled.
pub(crate) fn charged_of(order: &ActionHash, payee: &AgentPubKey, hold_ref: &ActionHash, settlements: &[(ActionHash, AgentPubKey, PaymentSettlement)]) -> ExternResult<Option<u64>> {
    let Some((settlement_ref, _, settlement)) = settlements.iter().find(|(_, author, s)| author == payee && &s.hold == hold_ref) else { return Ok(None) };
    let refunded: u64 = refunds_on(order, payee)?.iter().filter(|r| &r.settlement == settlement_ref).map(|r| r.amount).sum();
    Ok(Some(settlement.captured.saturating_sub(refunded)))
}

fn refunds_on(order: &ActionHash, author: &AgentPubKey) -> ExternResult<Vec<PaymentRefund>> {
    let mut out = Vec::new();
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToPayment)?.author(author.clone()), GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Some(refund) = get(hash, GetOptions::default())?.and_then(|r| decode_or::<PaymentRefund>(&r)) {
            out.push(refund);
        }
    }
    Ok(out)
}

// --- what a payee's agent did ---

/// The offer `offer_ref`, checked as the caller's to answer.
fn my_offer(offer_ref: &ActionHash) -> ExternResult<(PaymentOffer, AgentPubKey, LegContext)> {
    let record = get(offer_ref.clone(), GetOptions::default())?.ok_or(guest("That payment offer hasn't arrived yet."))?;
    let offer = decode_or::<PaymentOffer>(&record).ok_or(guest("that isn't a payment offer"))?;
    let context = leg(&offer.order, &offer.leg)?;
    if context.payee != me()? {
        return Err(guest("Only the payee answers a payment offer."));
    }
    Ok((offer, record.action().author().clone(), context))
}

/// Writes a payment record and links it under its order.
fn record(order: &ActionHash, entry: EntryTypes) -> ExternResult<ActionHash> {
    let hash = create_entry(&entry)?;
    create_link(order.clone(), hash.clone(), LinkTypes::OrderToPayment, ())?;
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordHoldInput {
    pub offer: ActionHash,
    /// The processor's id for the authorization.
    pub reference: String,
}

/// The payee's agent recording an authorization its processor made --
/// for what the leg needs, which the network sets, not the agent.
#[hdk_extern]
pub fn record_hold(input: RecordHoldInput) -> ExternResult<ActionHash> {
    let (offer, payer, context) = my_offer(&input.offer)?;
    let hash = record(&offer.order, EntryTypes::PaymentHold(PaymentHold { offer: input.offer, amount: context.required, reference: input.reference }))?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: offer.order.clone() }, vec![payer]);
    // What waited on it -- the store accepting, the driver committing or
    // picking up -- goes ahead.
    crate::upkeep::tend_my_stores_soon()?;
    crate::upkeep::tend_my_deliveries_soon()?;
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordActionInput {
    pub offer: ActionHash,
    /// What the payer's app needs to complete the processor's challenge.
    pub action: String,
}

/// The payee's agent asking the payer to complete their card's challenge.
#[hdk_extern]
pub fn record_action(input: RecordActionInput) -> ExternResult<ActionHash> {
    if input.action.is_empty() || input.action.len() > MAX_ACTION_CHARS {
        return Err(guest("that action is too long to pass on"));
    }
    let (offer, payer, _) = my_offer(&input.offer)?;
    let sealed = seal(&payer, &input.action)?;
    let hash = record(&offer.order, EntryTypes::PaymentAction(PaymentAction { offer: input.offer, sealed }))?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: offer.order.clone() }, vec![payer]);
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordDeclinedInput {
    pub offer: ActionHash,
    pub code: DeclineCode,
}

/// The payee's agent recording an offer its processor didn't authorize.
#[hdk_extern]
pub fn record_declined(input: RecordDeclinedInput) -> ExternResult<ActionHash> {
    let (offer, payer, _) = my_offer(&input.offer)?;
    let hash = record(&offer.order, EntryTypes::PaymentDeclined(PaymentDeclined { offer: input.offer, code: input.code }))?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: offer.order.clone() }, vec![payer]);
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordSettlementInput {
    pub hold: ActionHash,
    /// What the agent captured, part by part -- `payments_due`'s.
    pub claims: Vec<DueClaim>,
}

/// The payee's agent recording what it captured of a hold. Validation
/// checks every part against the order, so a wrong one is refused.
#[hdk_extern]
pub fn record_settlement(input: RecordSettlementInput) -> ExternResult<ActionHash> {
    let record_ = get(input.hold.clone(), GetOptions::default())?.ok_or(guest("hold not found"))?;
    let hold = decode_or::<PaymentHold>(&record_).ok_or(guest("that isn't a payment hold"))?;
    if record_.action().author() != &me()? {
        return Err(guest("Only whoever held a payment settles it."));
    }
    let (offer, payer, _) = my_offer(&hold.offer)?;
    let captured = input.claims.iter().map(|c| c.amount).sum();
    let claims = input.claims.into_iter().map(|c| c.claim).collect();
    let hash = record(&offer.order, EntryTypes::PaymentSettlement(PaymentSettlement { hold: input.hold, claims, captured }))?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: offer.order }, vec![payer]);
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordRefundInput {
    pub settlement: ActionHash,
    pub ruling: ActionHash,
    pub amount: u64,
}

/// The store's agent recording an award it refunded.
#[hdk_extern]
pub fn record_refund(input: RecordRefundInput) -> ExternResult<ActionHash> {
    let settlement_record = get(input.settlement.clone(), GetOptions::default())?.ok_or(guest("settlement not found"))?;
    let settlement = decode_or::<PaymentSettlement>(&settlement_record).ok_or(guest("that isn't a settlement"))?;
    let hold = get(settlement.hold.clone(), GetOptions::default())?.and_then(|r| decode_or::<PaymentHold>(&r)).ok_or(guest("hold not found"))?;
    let (offer, payer, _) = my_offer(&hold.offer)?;
    let hash = record(&offer.order, EntryTypes::PaymentRefund(PaymentRefund { settlement: input.settlement, ruling: input.ruling, amount: input.amount }))?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: offer.order }, vec![payer]);
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PaymentHoldInput {
    /// The order (its original action, or any version of it).
    pub order: ActionHash,
    pub leg: PaymentLeg,
}

/// The payee's hold of a leg of an order, once they've made it -- what a
/// step that needs it waits on. `None` too for a leg that needs nothing.
#[hdk_extern]
pub fn payment_hold(input: PaymentHoldInput) -> ExternResult<Option<ActionHash>> {
    let order = original_action_of(input.order)?;
    let Ok(context) = leg_context(&order, &input.leg)? else { return Ok(None) };
    hold_for(&order, &input.leg, &context.payee)
}

/// One payment held on an order: its leg, who pays whom, what was held, and
/// what was charged of it once settled.
#[derive(Serialize, Deserialize, Debug)]
pub struct OrderPayment {
    /// The payee's hold -- the payment's reference.
    pub hold: ActionHash,
    pub leg: PaymentLeg,
    pub payer: AgentPubKey,
    pub payee: AgentPubKey,
    pub held: u64,
    pub charged: Option<u64>,
}

/// Every payment held on an order -- public, as payment records are: what
/// each party paid whom, for an order's screens and receipts.
#[hdk_extern]
pub fn order_payments(order: ActionHash) -> ExternResult<Vec<OrderPayment>> {
    let order = original_action_of(order)?;
    let settlements = settlements_on(&order)?;
    let mut out = Vec::new();
    for (hold_ref, payee, hold, offer) in holds_on(&order)? {
        let Ok(Ok(context)) = leg_context(&order, &offer.leg) else { continue };
        if context.payee != payee {
            continue;
        }
        let charged = charged_of(&order, &payee, &hold_ref, &settlements)?;
        out.push(OrderPayment { hold: hold_ref, leg: offer.leg, payer: context.payer, payee, held: hold.amount, charged });
    }
    Ok(out)
}

/// Whether the store let an order's food go -- settled the customer's
/// payment without charging for it (declined, never answered, cancelled
/// before it cooked): then a reward the order spent comes back.
#[hdk_extern]
pub fn food_given_back(order: ActionHash) -> ExternResult<bool> {
    let order = original_action_of(order)?;
    let Some((_, merchant)) = crate::issues::parties_of(&order).ok() else { return Ok(false) };
    let Some((hold_ref, ..)) = holds_on(&order)?.into_iter().find(|(_, author, _, offer)| author == &merchant && offer.leg == PaymentLeg::Customer) else { return Ok(false) };
    Ok(settlements_on(&order)?.into_iter().any(|(_, author, s)| author == merchant && s.hold == hold_ref && !s.claims.iter().any(|c| c.part.portion == Portion::Food)))
}

// --- a party's history ---

/// One part of a payment, as charged.
#[derive(Serialize, Deserialize, Debug)]
pub struct ChargedPart {
    pub part: Part,
    pub amount: u64,
}

/// A payment the caller made or received: its order and leg, who paid
/// whom, what was held and charged -- part by part once settled -- and
/// when.
#[derive(Serialize, Deserialize, Debug)]
pub struct PaymentHistoryItem {
    pub order: ActionHash,
    /// The payee's hold -- the payment's reference.
    pub hold: ActionHash,
    pub leg: PaymentLeg,
    pub payer: AgentPubKey,
    pub payee: AgentPubKey,
    pub held: u64,
    pub charged: Option<u64>,
    pub parts: Vec<ChargedPart>,
    /// When it was settled -- or held, while it isn't.
    pub at: Timestamp,
    /// The order's store, by its name now -- "" if it can't be read.
    pub store_name: String,
    /// A delivery, or a pickup.
    pub delivery: bool,
}

/// The most history the caller's screens read at once.
const MAX_HISTORY_DAYS: u32 = 400;

/// Every payment the caller made or received in the last `days`, newest
/// first: for their earnings, their records, and seeing nobody skimmed.
#[hdk_extern]
pub fn my_payment_history(days: u32) -> ExternResult<Vec<PaymentHistoryItem>> {
    let me = me()?;
    let since = Timestamp::from_micros(sys_time()?.as_micros() - i64::from(days.min(MAX_HISTORY_DAYS)) * 86_400_000_000);
    let types = [EntryType::try_from(UnitEntryTypes::PaymentOffer)?, EntryType::try_from(UnitEntryTypes::PaymentHold)?];
    let mut orders: Vec<ActionHash> = Vec::new();
    for record in handshake_coordinator_support::chain::mine(&types).creates().since(since).records()? {
        let order = match (decode_or::<PaymentOffer>(&record), decode_or::<PaymentHold>(&record)) {
            (Some(offer), _) => Some(offer.order),
            (None, Some(hold)) => get(hold.offer, GetOptions::default())?.and_then(|r| decode_or::<PaymentOffer>(&r)).map(|o| o.order),
            _ => None,
        };
        if let Some(order) = order.filter(|o| !orders.contains(o)) {
            orders.push(order);
        }
    }
    let mut out = Vec::new();
    for order in orders {
        let settlements = settlements_on(&order)?;
        let placed = get(order.clone(), GetOptions::default())?;
        let found = placed.as_ref().and_then(|r| {
            decode_or::<DeliveryOrder>(r).map(|o| (OrderTerms::of_delivery(&o), o.catalog_ref)).or_else(|| decode_or::<PickupOrder>(r).map(|o| (OrderTerms::of_pickup(&o), o.catalog_ref)))
        });
        let Some((terms, catalog_ref)) = found else { continue };
        let store_name = crate::stores::current_catalog(&catalog_ref).map(|c| c.business_name).unwrap_or_default();
        for (hold_ref, payee, hold, offer) in holds_on(&order)? {
            let Ok(Ok(context)) = leg_context(&order, &offer.leg) else { continue };
            if context.payee != payee || (payee != me && context.payer != me) {
                continue;
            }
            let held_at = get(hold_ref.clone(), GetOptions::default())?.map(|r| r.action().timestamp()).unwrap_or(since);
            let settled = settlements.iter().find(|(_, author, s)| author == &payee && s.hold == hold_ref);
            let (charged, parts, at) = match settled {
                Some((settlement_ref, _, settlement)) => {
                    let mut parts: Vec<ChargedPart> = Vec::new();
                    for claim in settlement.claims.iter().filter(|c| c.part.portion != Portion::Food) {
                        let bid = match &claim.part.purpose {
                            HoldPurpose::DriverPay { bid } | HoldPurpose::Subsidy { bid } | HoldPurpose::Collateral { bid } => get(bid.clone(), GetOptions::default())?.and_then(|r| decode_or::<Bid>(&r)),
                            HoldPurpose::Food => None,
                        };
                        let amount = dispatch_integrity::direct::part_share(&terms, &claim.part, bid.as_ref()).map_or(0, |(_, amount)| amount);
                        parts.push(ChargedPart { part: claim.part.clone(), amount });
                    }
                    // The food is what the rest leaves: its settlement's refund,
                    // and any award refunded since, are off it.
                    let charged = charged_of(&order, &payee, &hold_ref, &settlements)?.unwrap_or(settlement.captured);
                    if let Some(food) = settlement.claims.iter().find(|c| c.part.portion == Portion::Food) {
                        let rest: u64 = parts.iter().map(|p| p.amount).sum();
                        parts.push(ChargedPart { part: food.part.clone(), amount: charged.saturating_sub(rest) });
                    }
                    let at = get(settlement_ref.clone(), GetOptions::default())?.map(|r| r.action().timestamp()).unwrap_or(held_at);
                    (Some(charged), parts, at)
                }
                None => (None, Vec::new(), held_at),
            };
            out.push(PaymentHistoryItem { order: order.clone(), hold: hold_ref, leg: offer.leg, payer: context.payer, payee, held: hold.amount, charged, parts, at, store_name: store_name.clone(), delivery: terms.delivery });
        }
    }
    out.sort_by_key(|item| std::cmp::Reverse(item.at));
    Ok(out)
}

/// How many holds the caller made, as a payee, that they haven't settled
/// yet -- what would lapse uncharged if their chain closed now
/// (`account::migrate_out` waits for none).
#[hdk_extern]
pub fn my_unsettled_holds(_: ()) -> ExternResult<u32> {
    let me = me()?;
    let mut unsettled = 0;
    for order in crate::settlement::candidates(DUE_DAYS)? {
        let settlements = settlements_on(&order)?;
        for (hold_ref, payee, ..) in holds_on(&order)? {
            if payee == me && !settlements.iter().any(|(_, author, s)| author == &me && s.hold == hold_ref) {
                unsettled += 1;
            }
        }
    }
    Ok(unsettled)
}

// --- what a payer owes ---

/// A payment the caller owes on an order: its leg, whom it pays, and
/// exactly what the network has them hold.
#[derive(Serialize, Deserialize, Debug)]
pub struct PaymentOwed {
    pub leg: PaymentLeg,
    pub payee: AgentPubKey,
    pub amount: u64,
}

/// What the caller pays on `order`, now: the customer's leg, and for the
/// driver the order has, their collateral (the driver's to pay) and their
/// pay (the store's) -- each for exactly what the network has held, so an
/// app shows the amount a card is held for, never one it worked out.
#[hdk_extern]
pub fn my_payments_owed(order: ActionHash) -> ExternResult<Vec<PaymentOwed>> {
    let me = me()?;
    let order = original_action_of(order)?;
    let mut legs = vec![PaymentLeg::Customer];
    let latest = handshake_coordinator_support::resolve_latest(order.clone())?;
    if let Some(bid) = decode_or::<DeliveryOrder>(&latest).and_then(|o| o.accepted_bid) {
        legs.push(PaymentLeg::DriverPay { bid: bid.clone() });
        legs.push(PaymentLeg::Collateral { bid });
    }
    let mut owed = Vec::new();
    for leg in legs {
        let Ok(Ok(context)) = leg_context(&order, &leg) else { continue };
        if context.payer == me && context.required > 0 {
            owed.push(PaymentOwed { leg, payee: context.payee, amount: context.required });
        }
    }
    Ok(owed)
}

// --- a payer's view ---

/// Where one of the caller's payments on an order stands.
#[derive(Serialize, Deserialize, Debug)]
pub enum PaymentStanding {
    /// Offered; the payee's agent hasn't answered.
    Waiting { offer: ActionHash },
    /// The card needs the payer to complete a challenge -- what their app
    /// shows them.
    ActionNeeded { offer: ActionHash, action: ActionHash, challenge: String },
    Declined { offer: ActionHash, code: DeclineCode },
    /// Held, for this much -- and charged, once settled.
    Held { hold: ActionHash, held: u64, charged: Option<u64> },
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MyPaymentInput {
    /// The order (its original action, or any version of it).
    pub order: ActionHash,
    pub leg: PaymentLeg,
}

/// Where the caller's payment for a leg of an order stands -- `None` if
/// they haven't offered one.
#[hdk_extern]
pub fn my_payment(input: MyPaymentInput) -> ExternResult<Option<PaymentStanding>> {
    let me = me()?;
    let order = original_action_of(input.order)?;
    let context = leg(&order, &input.leg)?;
    if context.payer != me {
        return Err(guest("That isn't a payment of yours."));
    }
    if let Some((hold_ref, _, hold, _)) = holds_on(&order)?.into_iter().find(|(_, author, _, offer)| author == &context.payee && offer.leg == input.leg) {
        let charged = settlements_on(&order)?.into_iter().find(|(_, author, s)| author == &context.payee && s.hold == hold_ref).map(|(_, _, s)| s.captured);
        return Ok(Some(PaymentStanding::Held { hold: hold_ref, held: hold.amount, charged }));
    }
    // My newest offer on the leg, and the payee's answer to it.
    let mut newest: Option<(Timestamp, ActionHash)> = None;
    let mut answers: Vec<(ActionHash, Record)> = Vec::new();
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToPayment)?, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        if record.action().author() == &me {
            if decode_or::<PaymentOffer>(&record).is_some_and(|o| o.leg == input.leg) && newest.as_ref().is_none_or(|(at, _)| record.action().timestamp() > *at) {
                newest = Some((record.action().timestamp(), hash));
            }
        } else if record.action().author() == &context.payee {
            answers.push((hash, record));
        }
    }
    let Some((_, offer_ref)) = newest else { return Ok(None) };
    for (hash, record) in answers {
        if let Some(declined) = decode_or::<PaymentDeclined>(&record).filter(|d| d.offer == offer_ref) {
            return Ok(Some(PaymentStanding::Declined { offer: offer_ref, code: declined.code }));
        }
        if let Some(action) = decode_or::<PaymentAction>(&record).filter(|a| a.offer == offer_ref) {
            let challenge = open::<String>(&context.payee, &action.sealed)?.ok_or(guest("couldn't read what your card asks"))?;
            return Ok(Some(PaymentStanding::ActionNeeded { offer: offer_ref, action: hash, challenge }));
        }
    }
    Ok(Some(PaymentStanding::Waiting { offer: offer_ref }))
}
