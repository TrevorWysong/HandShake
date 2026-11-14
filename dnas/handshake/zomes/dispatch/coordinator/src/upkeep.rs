//! What an agent's own conductor does for them with no app open, on the
//! conductor's scheduler (as `settlement` does for store payouts):
//!
//! - **A customer's orders.** A recurring order fires when it's due, a
//!   scheduled order is placed with its store when it's due, an order its
//!   store never answers is cancelled once the store's window passes
//!   (`Cancellation::StoreDidNotRespond`) -- so no customer waits on a
//!   store that's offline -- and a delivery picked up that never arrives is
//!   said never to have, once `handshake_governance::order_lapse` has run.
//! - **A store's new orders.** A store set to auto-accept accepts each one
//!   as it arrives, declining any priced from an outdated menu or with a
//!   goodie bag it can no longer sell.
//! - **A customer's driver.** For an order set to match automatically, the
//!   best bid by the network's published rule is accepted once the bid
//!   window has run (`matching::auto_match`).
//! - **A store's deliveries.** Each committed driver is confirmed (the
//!   kitchen starts), one out of time is moved on, a customer's request to
//!   collect is recorded once it's allowed, and an order no driver came for
//!   is ended (`deliveries::tend_store_delivery`).
//! - **A driver's deliveries.** Each order whose customer accepted their
//!   bid is committed to, and each the store has handed over is picked up
//!   (`deliveries::tend_driver_deliveries`).
//!
//! Each runs soon after what calls for it (the customer placing an order;
//! the store's `OrderPlaced` signal), and from a once-a-minute sweep
//! scheduled at `init`, which catches whatever a missed signal or a
//! restart left.
//!
//! A sweep only decides; each order's write happens in a call of its own
//! (`handshake_coordinator_support::isolated`). A zome call commits all its
//! writes or none, so otherwise one order whose write doesn't validate yet
//! would undo every other order's, every minute, until it resolved.

use crate::order_queues::{get_active_orders_for_store, get_my_active_orders, OrderEntry, OrderKind};
use crate::orders::{accept_delivery_order, cancel_delivery, open_scheduled_order, AcceptOrderInput, KitchenNote};
use crate::pickup::{accept_pickup_order, cancel_pickup};
use crate::pricing::{outdated_item, sold_out_item};
use crate::stores::{closed_reason, current_catalog, my_stores};
use dispatch_integrity::*;
use hdk::prelude::*;
use handshake_coordinator_support::{decode_or, guest, isolated, open_padded};
use handshake_governance::store_response_window;
use std::time::Duration;

/// Seconds, minutes, hours, day, month, weekday, year: every minute.
const SWEEP_CRON: &str = "0 * * * * * *";

/// Every minute, for as long as the conductor runs -- see the module doc.
/// Scheduled at `init`.
#[hdk_extern(infallible)]
pub fn tend_orders_periodically(_: Option<Schedule>) -> Option<Schedule> {
    if crate::settlement::moved_on() {
        return Some(Schedule::Persisted(SWEEP_CRON.into()));
    }
    let _ = tend_customer_orders();
    let _ = answer_store_orders();
    let _ = tend_store_deliveries();
    let _ = crate::deliveries::tend_driver_deliveries();
    Some(Schedule::Persisted(SWEEP_CRON.into()))
}

/// A moment past a deadline, so the update's own timestamp is clearly
/// beyond it.
const SLACK: Duration = Duration::from_secs(1);

// --- a store's deliveries ---

/// Asks the conductor to tend the caller's stores' deliveries now
/// (`tend_my_stores`). Called when one of them changes.
pub(crate) fn tend_my_stores_soon() -> ExternResult<()> {
    schedule("tend_my_stores")
}

/// Tends the caller's stores' deliveries, then runs again when the next one
/// falls due.
#[hdk_extern(infallible)]
pub fn tend_my_stores(_: Option<Schedule>) -> Option<Schedule> {
    match tend_store_deliveries() {
        Ok(Some(wait)) => Some(Schedule::Ephemeral(wait + SLACK)),
        _ => None,
    }
}

/// Tends every delivery at the caller's stores; returns how long until the
/// next one needs tending, if any does.
fn tend_store_deliveries() -> ExternResult<Option<Duration>> {
    let now = sys_time()?;
    let mut next: Option<Timestamp> = None;
    for store in my_stores()? {
        for entry in get_active_orders_for_store(store)? {
            let Some(order) = decode_or::<DeliveryOrder>(&entry.record).filter(|_| entry.kind == OrderKind::Delivery) else { continue };
            // One order failing (still gossiping, say) mustn't hold up the
            // rest; the next run tries it again.
            if let Ok(Some(due)) = crate::deliveries::tend_store_delivery(&entry.original_action, &entry.record, &order, now) {
                next = Some(next.map_or(due, |earliest| earliest.min(due)));
            }
        }
    }
    Ok(next.map(|due| Duration::from_micros(due.as_micros().saturating_sub(now.as_micros()).max(0) as u64)))
}

// --- a driver's deliveries ---

/// Asks the conductor to tend the caller's deliveries now
/// (`tend_my_deliveries`). Called when their bid is accepted, or the store
/// hands an order over.
pub(crate) fn tend_my_deliveries_soon() -> ExternResult<()> {
    schedule("tend_my_deliveries")
}

/// The signal can outrun what it's about, so this retries with backoff
/// until it's moved something on; the minute sweep covers anything later.
#[hdk_extern(infallible)]
pub fn tend_my_deliveries(previous: Option<Schedule>) -> Option<Schedule> {
    let moved = crate::deliveries::tend_driver_deliveries().is_ok_and(|n| n > 0);
    let next = match previous {
        Some(Schedule::Ephemeral(after)) => after * 2,
        _ => FIRST_RETRY,
    };
    (!moved && next <= LAST_RETRY).then_some(Schedule::Ephemeral(next))
}

// --- a customer's orders ---

/// Asks the conductor to tend the caller's orders now (`tend_my_orders`).
pub(crate) fn tend_my_orders_soon() -> ExternResult<()> {
    schedule("tend_my_orders")
}

/// Places the caller's due scheduled orders with their stores and cancels
/// those their stores haven't answered in time, then runs again when the
/// next one falls due.
#[hdk_extern(infallible)]
pub fn tend_my_orders(_: Option<Schedule>) -> Option<Schedule> {
    match tend_customer_orders() {
        Ok(Some(wait)) => Some(Schedule::Ephemeral(wait + SLACK)),
        _ => None,
    }
}

/// When an order next needs tending, in microseconds since the epoch.
type DueAt = i64;

/// Tends every order of the caller's that's waiting on time; returns how
/// long until the next one needs tending, if any does.
fn tend_customer_orders() -> ExternResult<Option<Duration>> {
    let now = sys_time()?.as_micros();
    let mut next: Option<DueAt> = None;
    for entry in get_my_active_orders(())? {
        // One order failing (still gossiping, say) mustn't hold up the rest;
        // the next run tries it again.
        if let Some(Some(due)) = isolated::<_, Option<DueAt>>("tend_one_order", SeenOrder::of(&entry)) {
            next = Some(next.map_or(due, |earliest| earliest.min(due)));
        }
    }
    // What the app has seen of them: a store starting, or declining.
    let _ = crate::confirmations::tend_confirmations();
    // Standing orders whose time has come ask their customer to confirm.
    if let Some(due) = crate::recurring::tend_templates(now)? {
        next = Some(next.map_or(due, |earliest| earliest.min(due)));
    }
    Ok(next.map(|due| Duration::from_micros(due.saturating_sub(now).max(0) as u64)))
}

/// One version of an order, as a sweep read it: what a call of its own
/// acts on -- that version, not whatever copy it might find.
#[derive(Serialize, Deserialize, Debug)]
pub struct SeenOrder {
    pub order: ActionHash,
    pub version: ActionHash,
}

impl SeenOrder {
    fn of(entry: &OrderEntry) -> Self {
        Self { order: entry.original_action.clone(), version: entry.record.action_address().clone() }
    }

    /// The queue entry it names, if that version can be read.
    fn entry(self) -> ExternResult<Option<OrderEntry>> {
        let Some(record) = get(self.version, GetOptions::default())? else { return Ok(None) };
        let kind = if decode_or::<DeliveryOrder>(&record).is_some() {
            OrderKind::Delivery
        } else if decode_or::<PickupOrder>(&record).is_some() {
            OrderKind::Pickup
        } else {
            return Ok(None);
        };
        Ok(Some(OrderEntry { kind, original_action: self.order, record }))
    }
}

/// Tends one of the caller's orders, in a call of its own (see the module
/// doc); returns when it next needs tending, if it will.
#[hdk_extern]
pub fn tend_one_order(seen: SeenOrder) -> ExternResult<Option<DueAt>> {
    let Some(entry) = seen.entry()? else { return Ok(None) };
    tend_order(&entry, sys_time()?.as_micros(), store_response_window().as_micros() as i64)
}

/// Tends one order; returns when it next needs tending, if it will.
fn tend_order(entry: &OrderEntry, now: DueAt, window: i64) -> ExternResult<Option<DueAt>> {
    // The latest version's timestamp: for an order waiting on its store,
    // when it reached the store -- what validation measures the window from.
    let written_at = entry.record.action().timestamp().as_micros();
    let order_ref = entry.original_action.clone();
    match entry.kind {
        OrderKind::Delivery => {
            let Some(order) = decode_or::<DeliveryOrder>(&entry.record) else { return Ok(None) };
            match order.status {
                DeliveryStatus::Scheduled => {
                    let due = order.requested_delivery_time.map_or(now, |at| at.as_micros());
                    if now < due {
                        return Ok(Some(due));
                    }
                    // Too late to send -- this device was away when it came
                    // due -- or a store closed at its time: never sent, the
                    // order is called off, and nobody owes anything.
                    if now >= due.saturating_add(handshake_governance::SCHEDULE_SEND_GRACE.as_micros() as i64) {
                        cancel_delivery(order_ref, Cancellation::ScheduleMissed)?;
                        return Ok(None);
                    }
                    let (_, store) = crate::stores::current_catalog_version(&order.catalog_ref)?;
                    if crate::stores::closed_reason(&store, now).is_some() {
                        cancel_delivery(order_ref, Cancellation::StoreClosed)?;
                        return Ok(None);
                    }
                    open_scheduled_order(order_ref)?;
                    Ok(Some(now + window))
                }
                DeliveryStatus::Placed if now >= written_at + window => {
                    cancel_delivery(order_ref, Cancellation::StoreDidNotRespond)?;
                    Ok(None)
                }
                DeliveryStatus::Placed => Ok(Some(written_at + window)),
                DeliveryStatus::Open if order.auto_match => Ok(crate::matching::auto_match(&order_ref, &order, now)?.map(|due| due.as_micros())),
                // Picked up and never brought, a day on: it never arrived,
                // said for a customer whose app was away -- so a driver who
                // keeps the food answers for it (`issues::decide_order`).
                DeliveryStatus::PickedUp if now >= written_at.saturating_add(handshake_governance::order_lapse().as_micros() as i64) => {
                    crate::never_arrived::claim_never_arrived(order_ref)?;
                    Ok(None)
                }
                // The driver committed: they get the address, in a call of its
                // own (`shares::share_address`).
                _ if crate::shares::owed_driver(&order_ref, &order)?.is_some() => {
                    let zome = zome_info()?.name;
                    call(CallTargetCell::Local, zome, "share_address".into(), None, order_ref)?;
                    Ok(None)
                }
                _ => Ok(None),
            }
        }
        OrderKind::Pickup => {
            let Some(order) = decode_or::<PickupOrder>(&entry.record) else { return Ok(None) };
            match order.status {
                PickupStatus::Placed if now >= written_at + window => {
                    cancel_pickup(order_ref, Cancellation::StoreDidNotRespond)?;
                    Ok(None)
                }
                PickupStatus::Placed => Ok(Some(written_at + window)),
                _ => Ok(None),
            }
        }
    }
}

// --- a store's new orders ---

/// Asks the conductor to answer the caller's stores' new orders now
/// (`answer_new_orders`). Called on the `OrderPlaced` signal.
pub(crate) fn answer_new_orders_soon() -> ExternResult<()> {
    schedule("answer_new_orders")
}

const FIRST_RETRY: Duration = Duration::from_secs(5);
const LAST_RETRY: Duration = Duration::from_secs(40);

/// The signal can arrive before the order has reached the store's queue,
/// so this retries with backoff (5s, 10s, ... ~75s in all) until it has
/// seen a waiting order and answered every one it should; the minute sweep
/// covers anything later.
#[hdk_extern(infallible)]
pub fn answer_new_orders(previous: Option<Schedule>) -> Option<Schedule> {
    let settled = matches!(answer_store_orders(), Ok(Answers { waiting, failed: 0 }) if waiting > 0);
    let next = match previous {
        Some(Schedule::Ephemeral(after)) => after * 2,
        _ => FIRST_RETRY,
    };
    (!settled && next <= LAST_RETRY).then_some(Schedule::Ephemeral(next))
}

struct Answers {
    /// Orders waiting on one of the caller's stores.
    waiting: u32,
    /// Orders it should have answered but couldn't yet.
    failed: u32,
}

/// Answers every waiting order the caller's stores answer automatically.
fn answer_store_orders() -> ExternResult<Answers> {
    let now = sys_time()?.as_micros();
    let window = store_response_window().as_micros() as i64;
    let mut answers = Answers { waiting: 0, failed: 0 };
    for store in my_stores()? {
        let catalog = current_catalog(&store)?;
        // Taking orders right now? An order placed while closed slipped past
        // the customer's own check, and is declined as such.
        let open_now = closed_reason(&catalog, now).is_none();
        for entry in get_active_orders_for_store(store)? {
            if WaitingOrder::from_entry(&entry).is_none() {
                continue;
            }
            answers.waiting += 1;
            // Past the window the store can't accept it; the customer's
            // conductor cancels it.
            let expired = now >= entry.record.action().timestamp().as_micros() + window;
            if expired || !catalog.auto_accept_orders {
                continue;
            }
            let auto_accept_requests = catalog.allergy_policy.as_ref().is_some_and(|policy| policy.auto_accept_requests);
            if isolated::<_, ()>("answer_one_order", AnswerInput { seen: SeenOrder::of(&entry), open_now, auto_accept_requests, hold_below: catalog.hold_below_customer_score, block_salt: catalog.block_salt.clone(), blocked: catalog.blocked.clone() }).is_none() {
                answers.failed += 1;
            }
        }
    }
    Ok(answers)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AnswerInput {
    pub seen: SeenOrder,
    /// Whether its store is taking orders right now.
    pub open_now: bool,
    /// Whether the store's let auto-accept take orders with allergies on them.
    pub auto_accept_requests: bool,
    /// Customers below this score are held for the store's review.
    #[serde(default)]
    pub hold_below: Option<u8>,
    /// The store's listing's list of the people it blocked, and its salt.
    #[serde(default)]
    pub block_salt: Vec<u8>,
    #[serde(default)]
    pub blocked: Vec<u8>,
}

/// Answers one order waiting on one of the caller's stores, in a call of
/// its own (see the module doc).
#[hdk_extern]
pub fn answer_one_order(input: AnswerInput) -> ExternResult<()> {
    let AnswerInput { seen, open_now, auto_accept_requests, hold_below, block_salt, blocked } = input;
    let order = seen.order.clone();
    let entry = seen.entry()?;
    let written_at = entry.as_ref().map(|entry| entry.record.action().timestamp().as_micros());
    let waiting = entry.as_ref().and_then(WaitingOrder::from_entry).ok_or(guest("that order isn't waiting on its store"))?;
    waiting.answer(&order, open_now, auto_accept_requests, hold_below, (&block_salt, &blocked), written_at.unwrap_or_default())
}

const ALLERGY_DECLINE_MARGIN_MICROS: i64 = 90_000_000;

/// An order waiting on its store to accept it.
struct WaitingOrder {
    kind: OrderKind,
    lines: Vec<OrderLine>,
    promo_code_ref: Option<ActionHash>,
    catalog_ref: ActionHash,
    /// The store terms it was placed under.
    catalog_version: ActionHash,
    /// The rewards program version it joined.
    rewards: Option<OrderRewards>,
    requester: AgentPubKey,
    kitchen_note: Option<XSalsa20Poly1305EncryptedData>,
}

impl WaitingOrder {
    fn from_entry(entry: &OrderEntry) -> Option<Self> {
        let (lines, promo_code_ref, catalog_ref, catalog_version, rewards, requester, kitchen_note) = match entry.kind {
            OrderKind::Delivery => {
                let order = decode_or::<DeliveryOrder>(&entry.record).filter(|o| o.status == DeliveryStatus::Placed)?;
                (order.lines, order.promo_code_ref, order.catalog_ref, order.catalog_version, order.rewards, order.requester, order.kitchen_note)
            }
            OrderKind::Pickup => {
                let order = decode_or::<PickupOrder>(&entry.record).filter(|o| o.status == PickupStatus::Placed)?;
                (order.lines, order.promo_code_ref, order.catalog_ref, order.catalog_version, order.rewards, order.requester, order.kitchen_note)
            }
        };
        Some(Self { kind: entry.kind, lines, promo_code_ref, catalog_ref, catalog_version, rewards, requester, kitchen_note })
    }

    fn has_allergies(&self) -> ExternResult<bool> {
        let Some(sealed) = &self.kitchen_note else { return Ok(false) };
        // A box this store can't open is treated as having some: a person sees it.
        Ok(open_padded::<KitchenNote>(&self.requester, sealed)?.is_none_or(|note| !note.allergies.is_empty()))
    }

    /// Accepts it, with the store's usual prep time -- or declines it if
    /// the store is closed (goodie bags alone run on their own windows), a
    /// goodie bag on it is sold out or gone, it was placed under the store's
    /// earlier terms, it's priced from an outdated menu, or an item on it has
    /// since sold out. An order with
    /// allergies on it waits for a person, unless the store's chosen otherwise --
    /// and, nobody having come, is declined before its window closes: left to
    /// lapse, anyone could mark an unattended store as never answering, by
    /// ordering with a sealed note its conductor won't accept.
    fn answer(&self, order_ref: &ActionHash, open_now: bool, auto_accept_requests: bool, hold_below: Option<u8>, (block_salt, blocked): (&[u8], &[u8]), written_at: i64) -> ExternResult<()> {
        let bags_only = crate::bags::bags_on(&self.lines)?.len() == self.lines.len();
        // A customer the store blocked, as its listing says: declined, nobody
        // charged.
        let blocked = handshake_types::block_prints::lists(blocked, block_salt, self.requester.get_raw_39());
        let decline = if blocked {
            Some(DeclineReason::NotServing)
        } else if !open_now && !bags_only {
            Some(DeclineReason::Closed)
        } else if crate::bags::unavailable_bag(order_ref, &self.lines)?.is_some() {
            Some(DeclineReason::BagUnavailable)
        } else if crate::pricing::terms_outdated(order_ref, &self.catalog_ref, &self.catalog_version)? || crate::pricing::rewards_outdated(order_ref, &self.catalog_ref, self.rewards.as_ref())? {
            Some(DeclineReason::TermsChanged)
        } else if outdated_item(order_ref, &self.lines, self.promo_code_ref.as_ref())?.is_some() {
            Some(DeclineReason::OutdatedPrices)
        } else if sold_out_item(&self.lines)?.is_some() {
            Some(DeclineReason::ItemsUnavailable)
        } else if crate::promos::promo_used_up(order_ref, self.promo_code_ref.as_ref())? {
            Some(DeclineReason::PromoUsedUp)
        } else {
            crate::acceptance::decline_for(&self.requester, &self.catalog_ref, self.rewards.as_ref())?
        };
        // Held for the store's own review: a customer below the score it
        // chose -- never declined for it, but nobody having come, declined
        // before its window closes (as an order with allergies is). A score
        // that can't be read holds it too: the store's choice never fails
        // open.
        let held = decline.is_none() && hold_below.is_some_and(|below| crate::blocks::customer_score(&self.requester).map_or(true, |score| score.is_some_and(|score| score < below)));
        let decline = match decline {
            None if held => {
                let window = store_response_window().as_micros() as i64;
                if sys_time()?.as_micros() < written_at + window - (window / 4).max(ALLERGY_DECLINE_MARGIN_MICROS) {
                    return Ok(());
                }
                Some(DeclineReason::NotReviewed)
            }
            None if !auto_accept_requests && self.has_allergies()? => {
                let window = store_response_window().as_micros() as i64;
                // At least long enough before it closes for this minute's sweep to come round.
                if sys_time()?.as_micros() < written_at + window - (window / 4).max(ALLERGY_DECLINE_MARGIN_MICROS) {
                    return Ok(());
                }
                Some(DeclineReason::CantMakeAsAsked)
            }
            decline => decline,
        };
        let accept = AcceptOrderInput { order_original_action: order_ref.clone(), prep_minutes: None };
        match (&self.kind, decline) {
            (OrderKind::Delivery, None) => accept_delivery_order(accept).map(|_| ()),
            (OrderKind::Delivery, Some(reason)) => cancel_delivery(order_ref.clone(), Cancellation::ByStore(reason)).map(|_| ()),
            (OrderKind::Pickup, None) => accept_pickup_order(accept).map(|_| ()),
            (OrderKind::Pickup, Some(reason)) => cancel_pickup(order_ref.clone(), Cancellation::ByStore(reason)).map(|_| ()),
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LapsedHoldsInput {
    pub catalog_ref: ActionHash,
    /// How many days back, up to 30.
    pub days: u32,
}

/// How many orders the caller's store declined in the last `days` because
/// it held them for a review nobody gave in time (docs/REPUTATION.md, phase
/// 4) -- shown beside the setting, so holding below a score never turns
/// into a ban by score unseen. Read from the store's own chain.
#[hdk_extern]
pub fn lapsed_holds(input: LapsedHoldsInput) -> ExternResult<u32> {
    let since = Timestamp::from_micros(sys_time()?.as_micros() - i64::from(input.days.clamp(1, 30)) * 86_400_000_000);
    let types = [EntryType::try_from(UnitEntryTypes::DeliveryOrder)?, EntryType::try_from(UnitEntryTypes::PickupOrder)?];
    let lapsed = Some(Cancellation::ByStore(DeclineReason::NotReviewed));
    let mut count = 0;
    for record in handshake_coordinator_support::chain::mine(&types).since(since).records()? {
        let (catalog, cancellation) = match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
            (Some(order), _) => (order.catalog_ref, order.cancellation),
            (None, Some(order)) => (order.catalog_ref, order.cancellation),
            _ => continue,
        };
        if catalog == input.catalog_ref && cancellation == lapsed {
            count += 1;
        }
    }
    Ok(count)
}

