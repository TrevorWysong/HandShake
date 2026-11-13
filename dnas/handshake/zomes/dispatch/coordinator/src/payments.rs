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

use crate::settlement::{holds_on, payment_records, settlement_due, settlements_on, DueClaim};
use dispatch_integrity::payments::{leg_context, LegContext};
use dispatch_integrity::*;
use handshake_coordinator_support::{arrived, call_local, call_role, decode_or, find_latest, guest, open, original_action_of, seal};
use hdk::prelude::*;
use std::collections::BTreeSet;

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
    /// Work done for the payee, while it's asking newcomers for some
    /// (`work_needed`).
    #[serde(default)]
    pub work: Option<WorkProof>,
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
    let offer = PaymentOffer { order: order.clone(), leg: leg_of, payee: context.payee.clone(), sealed_token, save: input.save && input.token.is_some(), resumes, work: input.work };
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

/// When the caller's card kept with `payee` was last kept or used, if it
/// still stands -- the rule validation holds every saved-card offer to
/// (`dispatch_integrity::payments::saved_card_with`), on their own chain.
pub(crate) fn saved_with(payee: &AgentPubKey) -> ExternResult<Option<Timestamp>> {
    let me = agent_info()?;
    dispatch_integrity::payments::saved_card_with(&me.agent_initial_pubkey, &me.chain_head.0, sys_time()?, payee)
}

/// A card the caller keeps with a payee, as their Payments screen lists it.
#[derive(Serialize, Deserialize, Debug)]
pub struct SavedCard {
    pub payee: AgentPubKey,
    /// The payee's store, when it's one: a driver's card kept with a store
    /// for their collateral. A store's kept with its driver names no store.
    pub store: Option<ActionHash>,
    /// When it's forgotten if it isn't used before then.
    pub stands_until: Timestamp,
}

/// Every card the caller keeps with a payee that still stands.
#[hdk_extern]
pub fn my_saved_cards(_: ()) -> ExternResult<Vec<SavedCard>> {
    let since = Timestamp::from_micros(sys_time()?.as_micros() - dispatch_integrity::payments::SAVED_CARD_DAYS * 86_400_000_000);
    let offers = handshake_coordinator_support::chain::mine(&[EntryType::try_from(UnitEntryTypes::PaymentOffer)?]).creates().since(since).records()?;
    let mut cards: Vec<SavedCard> = Vec::new();
    for record in offers.iter().rev() {
        let Some(offer) = decode_or::<PaymentOffer>(record) else { continue };
        if cards.iter().any(|c| c.payee == offer.payee) {
            continue;
        }
        let Some(last) = saved_with(&offer.payee)? else { continue };
        let store = if matches!(offer.leg, PaymentLeg::Collateral { .. }) { store_of(&offer.order)? } else { None };
        let stands_until = Timestamp::from_micros(last.as_micros() + dispatch_integrity::payments::SAVED_CARD_DAYS * 86_400_000_000);
        cards.push(SavedCard { payee: offer.payee, store, stands_until });
    }
    Ok(cards)
}

/// The store an order is from.
fn store_of(order: &ActionHash) -> ExternResult<Option<ActionHash>> {
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    Ok(decode_or::<DeliveryOrder>(&record).map(|o| o.catalog_ref).or_else(|| decode_or::<PickupOrder>(&record).map(|o| o.catalog_ref)))
}

/// The caller withdrawing the card they keep with `payee`: it pays nothing
/// more through HandShake, and the payee's agent deletes it from its
/// processor -- on the caller's record either way.
#[hdk_extern]
pub fn forget_saved_card(payee: AgentPubKey) -> ExternResult<ActionHash> {
    if saved_with(&payee)?.is_none() {
        return Err(guest("There's no card kept with them to forget."));
    }
    let hash = create_entry(&EntryTypes::SavedCardForgotten(SavedCardForgotten { payee: payee.clone() }))?;
    create_link(payee.clone(), hash.clone(), LinkTypes::AgentToForgottenCard, ())?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::CardForgotten, vec![payee]);
    Ok(hash)
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
    // My own offers, from this device: one that can't be read is an error,
    // never "not offered yet" -- which would offer the card twice.
    let offered = payment_records(order, Some(&me), GetStrategy::Local)?.iter().any(|record| decode_or::<PaymentOffer>(record).is_some_and(|o| o.leg == leg_of));
    if offered || saved_with(&context.payee)?.is_none() {
        return Ok(false);
    }
    // A card kept with the payee: one it has held before, never asked for work.
    offer(order, leg_of, PaymentInput { token: None, save: false, work: None })?;
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
        /// The payer has completed orders with several stores before
        /// (`established_payer_stores`): someone with a record, never asked
        /// for work when declined cards from new accounts look like card
        /// testing.
        payer_established: bool,
        /// The work the payer did for one of the payee's busy records, if
        /// any (`WorkProof`): which, and how many bits it proves.
        work: Option<WorkShown>,
        /// When the payer made the offer: what a kept card is dated by.
        offered_at: Timestamp,
    },
    /// Capture `captured` of a hold -- releasing the rest; nothing, to
    /// release it all -- and record the claims.
    Settle { hold: ActionHash, reference: String, held: u64, captured: u64, claims: Vec<DueClaim> },
    /// Refund an arbiter's award from a captured payment.
    Refund { settlement: ActionHash, reference: String, ruling: ActionHash, amount: u64 },
    /// Delete the card `payer` kept here from the processor -- they withdrew
    /// it `at`. A card they kept again after that stays.
    Forget { payer: AgentPubKey, at: Timestamp },
    /// What's due on `order` couldn't be worked out this time (`reason`):
    /// nothing to do on it yet, and the agent says so rather than taking
    /// silence for "nothing due". The next round tries it again.
    Unreadable { order: ActionHash, reason: String },
    /// `payer` withdrew the card they kept here -- the network has their
    /// withdrawal's link -- but the withdrawal itself couldn't be read this
    /// time (`reason`). Never taken for "not withdrawn": the agent charges
    /// their kept card for nothing meanwhile, and says so, and the next
    /// round reads it again -- then it's a `Forget`.
    WithdrawalUnreadable { payer: AgentPubKey, reason: String },
    /// An arbiter's award against one of the caller's stores whose ruling,
    /// or what it rests on, couldn't be read this time (`reason`): the
    /// refund waits, and the agent says so rather than taking it for none
    /// owed.
    RefundUnreadable { ruling: ActionHash, reason: String },
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
    // One order that can't be read never hides the rest -- nor itself: it's
    // reported, for the agent to show as trouble until it reads again.
    let candidates = crate::settlement::candidates(DUE_DAYS)?;
    for (order, reason) in candidates.unreadable {
        due.push(PaymentDue::Unreadable { order, reason });
    }
    for order in candidates.orders {
        match due_on(&order, &me) {
            Ok(on_it) => due.extend(on_it),
            Err(err) => due.push(PaymentDue::Unreadable { order, reason: err.to_string() }),
        }
    }
    due.extend(refunds_due(&me)?);
    due.extend(forgotten_cards(&me)?);
    Ok(due)
}

/// The cards payers have withdrawn from the caller, within the time a card
/// could still stand: each payer's latest withdrawal -- or, where one of
/// theirs couldn't be read, that it couldn't. A link's author is its
/// withdrawal's author (validation), so that's whose card waits.
fn forgotten_cards(me: &AgentPubKey) -> ExternResult<Vec<PaymentDue>> {
    let since = sys_time()?.as_micros() - dispatch_integrity::payments::SAVED_CARD_DAYS * 86_400_000_000;
    let mut due: Vec<PaymentDue> = Vec::new();
    for link in get_links(LinkQuery::try_new(me.clone(), LinkTypes::AgentToForgottenCard)?, GetStrategy::default())? {
        if link.timestamp.as_micros() < since {
            continue;
        }
        let Some(hash) = link.target.into_action_hash() else { continue };
        let record = match get(hash, GetOptions::default()) {
            Ok(Some(record)) => record,
            // Linked, so written: not reached here yet, or the read failed.
            Ok(None) => {
                due.push(PaymentDue::WithdrawalUnreadable { payer: link.author, reason: "not reached this device yet".into() });
                continue;
            }
            Err(err) => {
                due.push(PaymentDue::WithdrawalUnreadable { payer: link.author, reason: err.to_string() });
                continue;
            }
        };
        if decode_or::<SavedCardForgotten>(&record).is_none_or(|f| &f.payee != me) {
            continue;
        }
        let (payer, at) = (record.action().author().clone(), record.action().timestamp());
        match due.iter_mut().find_map(|d| match d {
            PaymentDue::Forget { payer: p, at: a } if p == &payer => Some(a),
            _ => None,
        }) {
            Some(latest) => *latest = (*latest).max(at),
            None => due.push(PaymentDue::Forget { payer, at }),
        }
    }
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
    for record in payment_records(order, None, GetStrategy::default())? {
        let hash = record.action_address().clone();
        let author = record.action().author().clone();
        if let Some(offer) = decode_or::<PaymentOffer>(&record) {
            offers.push((record.action().timestamp(), hash, author, offer));
        } else if author != *me {
            continue;
        } else if let Some(hold) = decode_or::<PaymentHold>(&record) {
            // Which leg a hold of mine is on, or this order can't be worked
            // out: a leg taken for unheld would be authorized twice.
            let offer = get(hold.offer.clone(), GetOptions::default())?.and_then(|r| decode_or::<PaymentOffer>(&r)).ok_or(guest("the offer one of my holds answers can't be read yet"))?;
            held_legs.push(offer.leg);
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
    // still settle; one that can't be read just now is an error, reported
    // (`Unreadable`) rather than taken for one that's over.
    let latest = find_latest(order.clone())?;
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
    for (offered_at, offer_ref, payer, offer) in offers.into_iter().rev() {
        if seen.contains(&offer.leg) || held_legs.contains(&offer.leg) || answered.contains(&offer_ref) || !wanted(&offer.leg) {
            continue;
        }
        let Ok(context) = leg_context(order, &offer.leg)? else { continue };
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
        let payer_established = established(&payer)?;
        let work = offer.work.as_ref().map(|proof| WorkShown { busy: proof.busy.clone(), bits: work_bits(&payer, me, proof) });
        due.push(PaymentDue::Authorize { offer: offer_ref, order: order.clone(), leg: offer.leg, amount: context.required, payer, token, save: offer.save, resumes: offer.resumes, newcomer_deal, payer_established, work, offered_at });
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
/// Whether `payer` has completed orders with the network's
/// `established_payer_stores` different store owners, none of them the
/// payer, placed at least `established_payer_days` ago, in their most
/// recent `established_payer_lookback` orders. That's someone with a
/// record: a new account has none, and making one takes as many stores,
/// each finishing an order, and time. A history that can't be read is an
/// error, never "no record": that would ask a regular for work, or turn
/// them away, for a moment's network trouble.
fn established(payer: &AgentPubKey) -> ExternResult<bool> {
    let needed = handshake_governance::established_payer_stores() as usize;
    let mut left = handshake_governance::established_payer_lookback() as usize;
    let days = i64::from(handshake_governance::established_payer_days());
    let now = sys_time()?;
    let settled_before = Timestamp::from_micros(now.as_micros().saturating_sub(days.saturating_mul(86_400_000_000)));
    let mut owners = BTreeSet::new();
    let mut before = None;
    while left > 0 {
        let page = crate::order_queues::history_page(QueueOwner::Customer(payer), before, Some(u32::try_from(left).unwrap_or(u32::MAX)))?;
        left = left.saturating_sub(page.orders.len().max(1));
        for entry in &page.orders {
            let completed = match (decode_or::<DeliveryOrder>(&entry.record), decode_or::<PickupOrder>(&entry.record)) {
                (Some(o), _) => (matches!(o.status, DeliveryStatus::Delivered | DeliveryStatus::Collected) && o.requested_at <= settled_before).then_some(o.merchant),
                (None, Some(o)) => (o.status == PickupStatus::PickedUp && o.requested_at <= settled_before).then_some(o.merchant),
                _ => None,
            };
            if let Some(owner) = completed.filter(|owner| owner != payer) {
                owners.insert(owner);
                if owners.len() >= needed {
                    return Ok(true);
                }
            }
        }
        let Some(next) = page.next_before else { break };
        before = Some(next);
    }
    Ok(false)
}

/// Work a payer showed for one of the payee's busy records.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WorkShown {
    pub busy: ActionHash,
    pub bits: u8,
}

/// What a busy payee asks of a payer with no history: work for its record
/// `busy`, of `bits`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WorkAsked {
    pub payee: AgentPubKey,
    pub busy: ActionHash,
    pub bits: u8,
}

/// The payee's busy record in force now, if there is one: its newest.
fn busy_now(payee: &AgentPubKey) -> ExternResult<Option<(ActionHash, PayeeBusy)>> {
    let query = LinkQuery::try_new(payee.clone(), LinkTypes::PayeeToBusy)?.author(payee.clone());
    let Some(link) = get_links(query, GetStrategy::default())?.into_iter().filter(|link| &link.author == payee).max_by_key(|link| link.timestamp) else { return Ok(None) };
    let Some(hash) = link.target.into_action_hash() else { return Ok(None) };
    // Linked, so written: not here yet is an error, never "not busy".
    let record = arrived(&hash)?;
    let now = sys_time()?;
    Ok(decode_or::<PayeeBusy>(&record).filter(|busy| busy.until > now && record.action().author() == payee).map(|busy| (record.action_address().clone(), busy)))
}

/// The work the caller must do before offering `payee` a card, if any: only
/// while the payee is seeing card testing, and only of a payer with no
/// record (`established`). Their app does it, and sends the proof with the
/// card (`PaymentInput::work`).
#[hdk_extern]
pub fn work_needed(payee: AgentPubKey) -> ExternResult<Option<WorkAsked>> {
    let Some((busy, record)) = busy_now(&payee)? else { return Ok(None) };
    // My own record unreadable just now: doing the work is the safe side
    // -- a moment of this device's time, which the payee takes either way
    // -- where skipping it would have the card declined.
    if established(&me()?).unwrap_or(false) {
        return Ok(None);
    }
    Ok(Some(WorkAsked { payee, busy, bits: record.bits }))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct WorkForLeg {
    pub order: ActionHash,
    pub leg: PaymentLeg,
}

/// `work_needed`, for a leg of an order already placed: its payee's.
#[hdk_extern]
pub fn work_needed_for_leg(input: WorkForLeg) -> ExternResult<Option<WorkAsked>> {
    let order = original_action_of(input.order)?;
    work_needed(leg(&order, &input.leg)?.payee)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BusyInput {
    /// How far past the network's first ask for work: each step doubles it.
    pub level: u8,
    pub until: Timestamp,
}

/// The caller's payment agent asking payers with no record for work, until
/// `until`, as it sees cards being tested: the network's first ask, doubled
/// `level` times, no more than its most. The record payers do it for.
#[hdk_extern]
pub fn record_busy(input: BusyInput) -> ExternResult<WorkAsked> {
    let me = me()?;
    let bits = handshake_governance::newcomer_work_bits().saturating_add(input.level).min(handshake_governance::newcomer_work_max_bits());
    let busy = create_entry(&EntryTypes::PayeeBusy(PayeeBusy { until: input.until, bits }))?;
    create_link(me.clone(), busy.clone(), LinkTypes::PayeeToBusy, ())?;
    Ok(WorkAsked { payee: me, busy, bits })
}

#[derive(Serialize, Deserialize, Debug)]
pub struct NewcomerCardInput {
    /// The store whose first-order deal it is.
    pub store: ActionHash,
    /// The card's fingerprint, as the payee's processor gives it.
    pub fingerprint: String,
    /// The order taking the deal.
    pub order: ActionHash,
}

/// A card's digest, as a store's claims of it are tagged: a hash of its
/// processor fingerprint, salted with the store's line (`line_root`). A
/// fingerprint is an opaque id only the payee's processor account gives
/// out, never the card's number, so nobody else can work back from the
/// digest; and salted, the same card's digests at two stores never match,
/// whatever ids their processors give. No key goes into it, so the store's
/// owner finds its claims whichever key they hold.
fn card_digest(root: &ActionHash, fingerprint: &str) -> Vec<u8> {
    holo_hash::encode::blake2b_256(&[b"handshake-newcomer-card:v3:".as_slice(), root.get_raw_39(), fingerprint.as_bytes()].concat())
}

/// `store` and every store it carries on from here, newest first: its line
/// (catalog's `store_line`), whose last is the root every claim is salted
/// with.
fn line_of(store: &ActionHash) -> ExternResult<Vec<ActionHash>> {
    let earlier: Vec<ActionHash> = call_local("catalog", "store_line", store.clone())?.map_err(|why| guest(format!("store_line: {why}")))?;
    Ok(std::iter::once(store.clone()).chain(earlier).collect())
}

/// The order a card took a store's first-order deal on, if it has: under
/// any store in its `line`, each claimed by whoever owned that store.
fn claimed_in_line(line: &[ActionHash], fingerprint: &str) -> ExternResult<Option<ActionHash>> {
    let digest = card_digest(line.last().expect("a line holds its store"), fingerprint);
    for catalog in line {
        // A store left out could hide where the card already took the deal.
        let record = arrived(catalog)?;
        let owner = record.action().author().clone();
        let query = LinkQuery::try_new(catalog.clone(), LinkTypes::StoreToNewcomerCard)?.author(owner.clone()).tag_prefix(LinkTag::new(digest.clone()));
        if let Some(link) = get_links(query, GetStrategy::default())?.into_iter().find(|link| link.author == owner && link.tag.0 == digest) {
            return Ok(link.target.into_action_hash());
        }
    }
    Ok(None)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct NewcomerCardClaim {
    pub store: ActionHash,
    pub fingerprint: String,
}

/// The order a card took `store`'s first-order deal on here, if it has --
/// asked by the next version of the network on the same device, through
/// its `previous` role, for a store brought over from here. The fingerprint
/// never leaves the device: it's salted and hashed here, as this network
/// keeps its claims.
#[hdk_extern]
pub fn newcomer_card_claim(input: NewcomerCardClaim) -> ExternResult<Option<ActionHash>> {
    claimed_in_line(&line_of(&input.store)?, &input.fingerprint)
}

/// Claims a store's first-order deal for a card, on `order`: `true` if the
/// card hasn't taken it before (now it has) or took it on this same order;
/// `false` if it took it on another -- at this store, at one it carries on
/// from, or at the store it was brought over from on the network before.
/// Kept on the network (a `StoreToNewcomerCard` link, tagged with the
/// card's digest), so no device the store loses forgets it, nor a key its
/// owner recovers from. Errs if the network before can't say just now.
#[hdk_extern]
pub fn claim_newcomer_card(input: NewcomerCardInput) -> ExternResult<bool> {
    let me = me()?;
    let store = get(input.store.clone(), GetOptions::default())?.ok_or(guest("That store couldn't be found."))?;
    if store.action().author() != &me {
        return Err(guest("Only the store's owner keeps its first-order deal."));
    }
    let line = line_of(&input.store)?;
    if let Some(took) = claimed_in_line(&line, &input.fingerprint)? {
        return Ok(took == input.order);
    }
    // The store it was brought over from, if the network before keeps its
    // cards this way: a version too old to has none this one can read --
    // they were kept another way, or on its devices.
    let origin: Option<ActionHash> = call_local("catalog", "imported_from_checked", line.last().expect("a line holds its store").clone())?.map_err(|why| guest(format!("imported_from_checked: {why}")))?;
    let answers = match &origin {
        Some(_) => handshake_coordinator_support::previous_answers(handshake_coordinator_support::bridge::DEAL_CARDS)?.map_err(|why| guest(format!("couldn't reach the previous network: {why}")))?,
        None => false,
    };
    if let Some(origin) = origin.filter(|_| answers) {
        let before: Option<ActionHash> = call_role("previous", "dispatch", "newcomer_card_claim", NewcomerCardClaim { store: origin, fingerprint: input.fingerprint.clone() })?.map_err(|why| guest(format!("couldn't read the previous network: {why}")))?;
        if before.is_some() {
            return Ok(false);
        }
    }
    let digest = card_digest(line.last().expect("a line holds its store"), &input.fingerprint);
    create_link(input.store, input.order, LinkTypes::StoreToNewcomerCard, LinkTag::new(digest))?;
    Ok(true)
}

/// What the order cites that isn't here yet is an error: taken for "no
/// deal", the card would go unchecked against the store's one per card.
fn newcomer_deal(order: &ActionHash) -> ExternResult<Option<ActionHash>> {
    let record = arrived(order)?;
    let (promo, store) = match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => (o.promo_code_ref, o.catalog_ref),
        (None, Some(o)) => (o.promo_code_ref, o.catalog_ref),
        _ => return Ok(None),
    };
    let Some(promo) = promo else { return Ok(None) };
    let promo = arrived(&promo)?;
    let first_only = decode_or::<catalog_types::PromoCode>(&promo).is_some_and(|p| p.limits.first_order_only);
    Ok(first_only.then_some(store))
}

/// Awards against the caller's stores not yet refunded in full -- each on
/// its own: one that can't be read is reported (`RefundUnreadable`), and
/// the rest go on.
fn refunds_due(me: &AgentPubKey) -> ExternResult<Vec<PaymentDue>> {
    let mut due = Vec::new();
    for link in get_links(LinkQuery::try_new(me.clone(), LinkTypes::StoreOwnerToRuling)?, GetStrategy::default())? {
        let Some(ruling_ref) = link.target.into_action_hash() else { continue };
        match refund_due(me, &ruling_ref) {
            Ok(refund) => due.extend(refund),
            Err(err) => due.push(PaymentDue::RefundUnreadable { ruling: ruling_ref, reason: err.to_string() }),
        }
    }
    Ok(due)
}

/// What's still to refund of the award `ruling_ref`, if anything. The
/// ruling is validated against its appeal, and that against its order, so
/// any of them not here yet is an error, never "nothing owed".
fn refund_due(me: &AgentPubKey, ruling_ref: &ActionHash) -> ExternResult<Option<PaymentDue>> {
    let record = arrived(ruling_ref)?;
    let Some(ruling) = decode_or::<Ruling>(&record) else { return Ok(None) };
    if ruling.award == 0 {
        return Ok(None);
    }
    let appeal = arrived(&ruling.appeal)?;
    let Some(appeal) = decode_or::<Appeal>(&appeal) else { return Ok(None) };
    // The store's settlement of the customer's payment, and what it's
    // refunded from it. None yet: the award waits for the settlement.
    let Some((hold_ref, _, hold, _)) = holds_on(&appeal.order)?.into_iter().find(|(_, author, _, offer)| author == me && offer.leg == PaymentLeg::Customer) else { return Ok(None) };
    let Some((settlement_ref, _, settlement)) = settlements_on(&appeal.order)?.into_iter().find(|(_, author, s)| author == me && s.hold == hold_ref) else { return Ok(None) };
    let refunds: Vec<PaymentRefund> = refunds_on(&appeal.order, me)?;
    let paid: u64 = refunds.iter().filter(|r| r.ruling == *ruling_ref).map(|r| r.amount).sum();
    let from_settlement: u64 = refunds.iter().filter(|r| r.settlement == settlement_ref).map(|r| r.amount).sum();
    let amount = ruling.award.saturating_sub(paid).min(settlement.captured.saturating_sub(from_settlement));
    Ok((amount > 0).then(|| PaymentDue::Refund { settlement: settlement_ref, reference: hold.reference, ruling: ruling_ref.clone(), amount }))
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
    Ok(payment_records(order, Some(author), GetStrategy::default())?.iter().filter_map(decode_or::<PaymentRefund>).collect())
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
        let Ok(context) = leg_context(&order, &offer.leg)? else { continue };
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
    // An order that can't be read is an error -- the reward's fate waits
    // on it -- and only something that isn't an order gave nothing back.
    let record = get(order.clone(), GetOptions::default())?.ok_or(guest("the order can't be read yet"))?;
    let Some((_, merchant)) = crate::issues::parties_in(&record) else { return Ok(false) };
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
            (None, Some(hold)) => decode_or::<PaymentOffer>(&arrived(&hold.offer)?).map(|o| o.order),
            _ => None,
        };
        if let Some(order) = order.filter(|o| !orders.contains(o)) {
            orders.push(order);
        }
    }
    let mut out = Vec::new();
    for order in orders {
        let settlements = settlements_on(&order)?;
        // Each record here is one a validated payment names: one not read
        // yet is an error, never a payment left out or priced at nothing.
        let placed = arrived(&order)?;
        let found = decode_or::<DeliveryOrder>(&placed).map(|o| (OrderTerms::of_delivery(&o), o.catalog_ref)).or_else(|| decode_or::<PickupOrder>(&placed).map(|o| (OrderTerms::of_pickup(&o), o.catalog_ref)));
        let Some((terms, catalog_ref)) = found else { continue };
        let store_name = crate::stores::current_catalog(&catalog_ref).map(|c| c.business_name).unwrap_or_default();
        for (hold_ref, payee, hold, offer) in holds_on(&order)? {
            let Ok(context) = leg_context(&order, &offer.leg)? else { continue };
            if context.payee != payee || (payee != me && context.payer != me) {
                continue;
            }
            let held_at = arrived(&hold_ref)?.action().timestamp();
            let settled = settlements.iter().find(|(_, author, s)| author == &payee && s.hold == hold_ref);
            let (charged, parts, at) = match settled {
                Some((settlement_ref, _, settlement)) => {
                    let mut parts: Vec<ChargedPart> = Vec::new();
                    for claim in settlement.claims.iter().filter(|c| c.part.portion != Portion::Food) {
                        let bid = match &claim.part.purpose {
                            HoldPurpose::DriverPay { bid } | HoldPurpose::Subsidy { bid } | HoldPurpose::Collateral { bid } => decode_or::<Bid>(&arrived(bid)?),
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
                    let at = arrived(settlement_ref)?.action().timestamp();
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
    // Every order, or no count: one missed could let the chain close on a
    // hold still to settle.
    for order in crate::settlement::candidates(DUE_DAYS)?.all()? {
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
        let Ok(context) = leg_context(&order, &leg)? else { continue };
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
    for record in payment_records(&order, None, GetStrategy::default())? {
        let hash = record.action_address().clone();
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
