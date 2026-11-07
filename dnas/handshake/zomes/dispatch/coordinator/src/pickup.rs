//! The pickup vertical's full lifecycle -- `PickupOrder`'s own doc comment
//! (`dispatch_integrity`) explains why this is a separate entry type and
//! status machine rather than a flag on `DeliveryOrder`. No bid, no driver,
//! no leg attestation: the requester and the merchant are the only two
//! parties, so this file covers creation through completion *and* its own
//! dispute path in one place, rather than splitting across files the way
//! `orders.rs`/`disputes.rs` do for the much larger delivery vertical.

use crate::upkeep;
use handshake_integrity_support::allergens::AllergySet;
use crate::stores::{closed_reason, current_catalog_version, ready_by};
use crate::orders::{ensure_promo_usable, my_name, seal_kitchen_note, seal_note, AcceptOrderInput, DeclineOrderInput, record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use crate::pricing::{ensure_current_terms, ensure_priced_from_current_menu, ensure_store_minimum, price_order, OrderItem};
use crate::signals::RemoteSignal;
use crate::order_queues::{self, OrderParties};
use dispatch_integrity::*;
use hdk::prelude::*;
use handshake_coordinator_support::{guest, original_action_of, resolve_version_decoded, update_version, written};

#[derive(Serialize, Deserialize, Debug)]
pub struct RequestPickupOrderInput {
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// What to order -- see `RequestDeliveryInput::items`.
    pub items: Vec<OrderItem>,
    /// The total the customer was shown -- see `RequestDeliveryInput::order_total`.
    pub order_total: u64,
    /// A note for the kitchen -- sealed to the store.
    #[serde(default)]
    pub kitchen_notes: String,
    /// Allergies the customer's telling the store -- sealed with the note.
    #[serde(default)]
    pub allergies: AllergySet,
    #[serde(default)]
    pub promo_code_ref: Option<ActionHash>,
    /// The customer confirming their age, for age-restricted items.
    #[serde(default)]
    pub age_confirmed: bool,
    /// A wake token from the network's push relay, sealed to the store --
    /// see `RequestDeliveryInput::wake_for_store`.
    #[serde(default)]
    pub wake_for_store: Option<String>,
    /// A reward of the store's rewards program to spend points on -- its id.
    #[serde(default)]
    pub reward: Option<u16>,
    /// The customer's card for it -- see `RequestDeliveryInput::payment`.
    #[serde(default)]
    pub payment: Option<crate::payments::PaymentInput>,
}

/// No matching/signal-fanout step here unlike `orders::request_delivery` --
/// there's no driver to find, so the only two parties who ever need to know
/// about this order are the two already named on it. The store still
/// needs to find it, through the same store queues deliveries use.
#[hdk_extern]
pub fn request_pickup_order(input: RequestPickupOrderInput) -> ExternResult<Record> {
    let requester = agent_info()?.agent_initial_pubkey;
    let catalog_ref = input.catalog_ref.clone();
    let requested_at = sys_time()?;

    if let Some(promo_ref) = &input.promo_code_ref {
        ensure_promo_usable(promo_ref, &input.catalog_ref)?;
        crate::promos::ensure_promo_allowed(promo_ref, &input.catalog_ref)?;
    }
    order_queues::ensure_order_rate()?;

    // The store as it is now: the terms this order is placed under.
    let (catalog_version, catalog) = current_catalog_version(&input.catalog_ref)?;
    // The store's rewards program, and any reward chosen, priced in.
    let joining = crate::pricing::joining(&input.catalog_ref, input.reward)?;
    let reward = joining.as_ref().and_then(|j| j.reward.as_ref().map(|(_, benefit)| benefit));
    let priced = price_order(&input.catalog_ref, &catalog, &input.items, input.promo_code_ref.as_ref(), reward, false, input.order_total)?;
    ensure_store_minimum(&catalog, &priced)?;
    crate::pricing::ensure_age_rules(&priced, false, input.age_confirmed)?;
    // Open now -- goodie bags alone run on their own windows instead.
    if priced.menu_subtotal.is_some() {
        if let Some(reason) = closed_reason(&catalog, requested_at.as_micros()) {
            return Err(guest(reason));
        }
    }

    let kitchen_note = Some(seal_kitchen_note(&input.merchant, catalog.allergy_policy.as_ref(), &input.kitchen_notes, input.allergies)?);
    let sealed_customer_name = seal_note(&input.merchant, &my_name()?)?;
    let sealed_wake = crate::orders::seal_wake(&input.merchant, input.wake_for_store.as_deref())?;
    let order = PickupOrder {
        requester: requester.clone(),
        merchant: input.merchant,
        catalog_ref: input.catalog_ref,
        catalog_version,
        lines: priced.lines,
        order_total: priced.order_total,
        tax_cents: priced.tax_cents,
        age_confirmed: input.age_confirmed,
        status: PickupStatus::Placed,
        requested_at,
        kitchen_note,
        sealed_customer_name,
        sealed_wake,
        promo_code_ref: input.promo_code_ref,
        loyalty_proof: priced.loyalty_proof,
        rewards: crate::pricing::join(&catalog_ref, joining)?,
        cancellation: None,
        ready_by: None,
        customer_payment: None,
        beacon: None,
    };
    let action_hash = create_entry(&EntryTypes::PickupOrder(order))?;
    // The customer's card, offered with it -- see `request_delivery`.
    if let Some(payment) = input.payment {
        crate::payments::offer(&action_hash, PaymentLeg::Customer, payment)?;
    }
    order_queues::enqueue(&action_hash, &catalog_ref, &requester, requested_at)?;
    upkeep::tend_my_orders_soon()?;

    written(action_hash)
}

#[hdk_extern]
pub fn get_pickup_order(order_original_action: ActionHash) -> ExternResult<Record> {
    handshake_coordinator_support::resolve_latest(order_original_action)
}

/// `Placed -> MerchantConfirmed` -- the store accepting the order and
/// starting on it, once it's checked the order is priced from its current
/// menu (see `ensure_priced_from_current_menu`), and saying when it'll be
/// ready. Only the store can.
#[hdk_extern]
pub fn accept_pickup_order(input: AcceptOrderInput) -> ExternResult<Record> {
    let order_original_action = input.order_original_action;
    let (current, mut order): (_, PickupOrder) = resolve_version_decoded(order_original_action.clone(), "PickupOrder")?;
    if order.status != PickupStatus::Placed {
        return Err(guest("This order has already been accepted or cancelled."));
    }
    if order.merchant != agent_info()?.agent_initial_pubkey {
        return Err(guest("Only the order's store can accept it."));
    }
    crate::accounts::ensure_not_moved(&order.requester, "This customer")?;
    ensure_priced_from_current_menu(&order_original_action, &order.lines, order.promo_code_ref.as_ref())?;
    crate::bags::ensure_bags_left(&order_original_action, &order.lines)?;
    ensure_current_terms(&order_original_action, &order.catalog_ref, &order.catalog_version)?;
    crate::pricing::ensure_current_program(&order_original_action, &order.catalog_ref, order.rewards.as_ref())?;
    crate::promos::ensure_promo_left(&order_original_action, order.promo_code_ref.as_ref())?;
    crate::acceptance::ensure_acceptable(&order.requester, &order.catalog_ref, order.rewards.as_ref())?;
    let promo = order.promo_code_ref.clone();
    let rewards = order.rewards.clone();
    let lines = order.lines.clone();
    let original = handshake_coordinator_support::original_action_of(order_original_action.clone())?;
    order.customer_payment = crate::payments::step_payment(&original, &PaymentLeg::Customer, &order.merchant, "The customer's payment isn't held yet. Your app holds it as soon as their card comes through.")?;
    order.ready_by = Some(ready_by(&order.catalog_ref, input.prep_minutes)?);
    order.status = PickupStatus::MerchantConfirmed;
    let updated = update_version(&current, &EntryTypes::PickupOrder(order), LinkTypes::Version)?;
    crate::promos::record_promo_use(&original, promo.as_ref())?;
    crate::bags::record_bag_sales(&original, &lines)?;
    crate::acceptance::record_member_order(&original, &updated, rewards.as_ref())?;
    written(updated)
}

/// `MerchantConfirmed -> ReadyForPickup` -- signals the requester directly
/// (best-effort fast path, same posture as every other signal in this
/// crate; the requester's own client falls back to polling `get_pickup_order`
/// if it's missed).
#[hdk_extern]
pub fn mark_ready_for_pickup(order_original_action: ActionHash) -> ExternResult<Record> {
    let (current, mut order): (_, PickupOrder) = resolve_version_decoded(order_original_action, "PickupOrder")?;
    order.status = PickupStatus::ReadyForPickup;
    let requester = order.requester.clone();
    let updated = update_version(&current, &EntryTypes::PickupOrder(order), LinkTypes::Version)?;
    let _ = send_remote_signal(RemoteSignal::PickupReady { order_hash: updated.clone() }, vec![requester]);
    written(updated)
}

/// The customer withdrawing their pickup order -- see `orders::cancel_order`.
#[hdk_extern]
pub fn cancel_pickup_order(order_original_action: ActionHash) -> ExternResult<Record> {
    cancel_pickup(order_original_action, Cancellation::ByCustomer)
}

/// The store turning a pickup order down, or calling it off, and why.
#[hdk_extern]
pub fn decline_pickup_order(input: DeclineOrderInput) -> ExternResult<Record> {
    cancel_pickup(input.order_original_action, Cancellation::ByStore(input.reason))
}

/// Cancels a pickup order for `reason`, which validation checks against the
/// caller, and takes it off every queue.
pub(crate) fn cancel_pickup(order_original_action: ActionHash, reason: Cancellation) -> ExternResult<Record> {
    let (current, mut order): (_, PickupOrder) = resolve_version_decoded(order_original_action.clone(), "PickupOrder")?;
    order.status = PickupStatus::Cancelled;
    order.cancellation = Some(reason);
    let updated = update_version(&current, &EntryTypes::PickupOrder(order.clone()), LinkTypes::Version)?;
    order_queues::retire(&OrderParties::pickup(&order_original_action, &order))?;
    let record = written(updated)?;
    crate::orders::record_cancellation(&record, &order_original_action)?;
    Ok(record)
}

/// The store recording a ready pickup its customer never came for, once the
/// collection window from its being ready has passed -- with proof of the
/// time, which validation checks: it keeps the food's price, and it counts
/// against the customer. Never one they've said they can't get
/// (`Disputed`): that, the store answers first.
#[hdk_extern]
pub fn mark_pickup_not_collected(input: crate::deliveries::TimedStepInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (current, mut order): (_, PickupOrder) = resolve_version_decoded(order_ref.clone(), "PickupOrder")?;
    if order.merchant != agent_info()?.agent_initial_pubkey || order.status != PickupStatus::ReadyForPickup {
        return Err(guest("Only the store records a ready order nobody came for as uncollected."));
    }
    let window_ends = Timestamp::from_micros(current.record.action().timestamp().as_micros().saturating_add(handshake_governance::collection_window().as_micros() as i64));
    if handshake_integrity_support::beacon::proves_past(input.beacon.as_ref(), window_ends).is_err() {
        return Err(guest("The customer still has time to collect it."));
    }
    order.status = PickupStatus::Cancelled;
    order.cancellation = Some(Cancellation::NotCollected);
    order.beacon = input.beacon;
    let updated = update_version(&current, &EntryTypes::PickupOrder(order.clone()), LinkTypes::Version)?;
    order_queues::retire(&OrderParties::pickup(&order_ref, &order))?;
    let record = written(updated)?;
    crate::orders::record_cancellation(&record, &order_ref)?;
    Ok(record)
}

/// The gated completion path -- `ReadyForPickup -> PickedUp`, called by the
/// requester confirming they actually received it. Unlike
/// `complete_delivery`, there's no leg-attestation gate to check first: the
/// merchant and requester transact directly, with no intermediary to prove
/// anything about. The customer pays the order total; there's no delivery
/// fee or tip.
#[hdk_extern]
pub fn complete_pickup(order_original_action: ActionHash) -> ExternResult<Record> {
    let (current, mut order): (_, PickupOrder) = resolve_version_decoded(order_original_action.clone(), "PickupOrder")?;
    if !matches!(order.status, PickupStatus::ReadyForPickup | PickupStatus::Disputed) {
        return Err(guest("A pickup order can be collected only once it's ready."));
    }
    let merchant = order.merchant.clone();
    let catalog_ref = order.catalog_ref.clone();
    order.status = PickupStatus::PickedUp;
    let parties = OrderParties::pickup(&order_original_action, &order);
    let updated = update_version(&current, &EntryTypes::PickupOrder(order), LinkTypes::Version)?;
    order_queues::retire(&parties)?;
    // This update is the customer's receipt: the store settles the food's
    // held payment on it once their report window has run (`issues`).

    // The store's completed order, on the version completing it. Skipped
    // for a merchant picking up from their own store (see `record_reputation_event`).
    record_reputation_event(&merchant, ReputationTargetWire::Store(catalog_ref), order_original_action, ReputationEventKindWire::OrderCompleted, updated.clone())?;

    written(updated)
}

/// The customer telling the store they can't get their order (it isn't
/// there, or isn't being handed over), once. The store decides: it cancels,
/// and nobody's charged (`decline_pickup_order`), or it says the order's ready
/// (`dismiss_pickup_problem`).
#[hdk_extern]
pub fn report_pickup_problem(order_original_action: ActionHash) -> ExternResult<Record> {
    let (current, mut order): (_, PickupOrder) = resolve_version_decoded(order_original_action.clone(), "PickupOrder")?;
    if order.status != PickupStatus::ReadyForPickup {
        return Err(guest("You can report a problem once the store says it's ready."));
    }
    // Validation's rule, told first.
    if crate::issues::report_dismissed(&current.record)? {
        return Err(guest("The store has already answered that this order is ready."));
    }
    order.status = PickupStatus::Disputed;
    let updated = update_version(&current, &EntryTypes::PickupOrder(order), LinkTypes::Version)?;
    written(updated)
}

/// The store answering that a pickup its customer says they can't get is
/// ready. Their window to collect it starts again, and past it the store may
/// record it uncollected and keep the food's price
/// (`mark_pickup_not_collected`). Its conductor gives this answer for a store
/// that hasn't, once its grace has run (`issues::decide_order`): nobody's
/// charged by that alone.
#[hdk_extern]
pub fn dismiss_pickup_problem(order_original_action: ActionHash) -> ExternResult<Record> {
    let (current, mut order): (_, PickupOrder) = resolve_version_decoded(order_original_action, "PickupOrder")?;
    if order.merchant != agent_info()?.agent_initial_pubkey || order.status != PickupStatus::Disputed {
        return Err(guest("Only the store answers a customer who says they can't get their order."));
    }
    order.status = PickupStatus::ReadyForPickup;
    let requester = order.requester.clone();
    let updated = update_version(&current, &EntryTypes::PickupOrder(order), LinkTypes::Version)?;
    let _ = send_remote_signal(RemoteSignal::PickupReady { order_hash: updated.clone() }, vec![requester]);
    written(updated)
}
