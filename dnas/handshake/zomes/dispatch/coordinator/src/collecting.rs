//! A customer collecting their delivery from the store themselves -- when
//! no driver has it, or its driver is late.

use crate::deliveries::{current, driver_due, driver_of, me, past, ready_in, without_driver, write, TimedStepInput};
use crate::order_queues::{retire, OrderParties};
use crate::orders::{record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use crate::signals::RemoteSignal;
use dispatch_integrity::lineage::{self, Version};
use dispatch_integrity::*;
use hdk::prelude::*;
use handshake_coordinator_support::{call_local, EntryVersion, guest, original_action_of};
use handshake_types::Beacon;


/// The customer asking to collect their delivery from the store themselves
/// -- when no driver has it, or its driver is late. The store's app records
/// it (`record_collecting`) as soon as it's allowed; its share of the fee it
/// would have paid a driver comes back to them.
#[hdk_extern]
pub fn request_collect(order_ref: ActionHash) -> ExternResult<ActionHash> {
    let order_ref = original_action_of(order_ref)?;
    let (_, order) = current(&order_ref)?;
    if order.requester != me()? {
        return Err(guest("Only the order's customer can collect it."));
    }
    if let Some(existing) = collect_request_of(&order_ref, &order.requester)? {
        return Ok(existing);
    }
    if !matches!(order.status, DeliveryStatus::Open | DeliveryStatus::BidAccepted | DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed) {
        return Err(guest("This order can't be switched to collecting now."));
    }
    let request = create_entry(&EntryTypes::CollectRequest(CollectRequest { order: order_ref.clone() }))?;
    create_link(order_ref.clone(), request.clone(), LinkTypes::OrderToCollectRequest, ())?;
    let _ = send_remote_signal(RemoteSignal::CollectRequested { order_hash: order_ref }, vec![order.merchant]);
    Ok(request)
}

/// The customer's request to collect `order`, if they've made one.
pub(crate) fn collect_request_of(order: &ActionHash, requester: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    Ok(get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToCollectRequest)?.author(requester.clone()), GetStrategy::default())?.into_iter().find_map(|link| link.target.into_action_hash()))
}

/// The store recording its customer's request to collect: the order leaves
/// its driver (moved on, as if late) and waits at the counter for them. Its
/// app does it as soon as it's allowed (`tend_store_deliveries`).
#[hdk_extern]
pub fn record_collecting(input: TimedStepInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (version, mut order) = current(&order_ref)?;
    if order.merchant != me()? {
        return Err(guest("Only the order's store records it collecting."));
    }
    let request = collect_request_of(&order_ref, &order.requester)?.ok_or(guest("The customer hasn't asked to collect it."))?;
    let committed = order.collateral_payment.is_some();
    let released = match driver_of(&order)? {
        Some((bid_ref, bid)) => {
            match driver_due(&version.record, &order, &bid)? {
                Some(due) if past(due, committed, input.beacon.as_ref())? => {}
                _ => return Err(guest("The driver still has time; the customer can collect it if they're late.")),
            }
            Some((bid_ref, bid.bidder))
        }
        None => None,
    };
    if committed {
        order.beacon = input.beacon;
    }
    if order.ready_by.is_none() {
        order.ready_by = Some(ready_in(order.prep_minutes)?);
    }
    without_driver(&mut order);
    order.status = DeliveryStatus::Collecting;
    order.collect_request = Some(request);
    let collecting = write(&version, order)?;
    if let Some((bid_ref, driver)) = released {
        let _ = send_remote_signal(RemoteSignal::BidReleased { bid_hash: bid_ref }, vec![driver]);
    }
    Ok(collecting)
}

/// The customer confirming they've collected it.
#[hdk_extern]
pub fn confirm_collected(order_ref: ActionHash) -> ExternResult<Record> {
    collected(order_ref, None)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HandOverInput {
    pub order_original_action: ActionHash,
    /// The customer's handover code, as the store scanned it.
    pub code: PinSecret,
}

/// The store handing the order over at its counter, against the customer's
/// code.
#[hdk_extern]
pub fn hand_over_collection(input: HandOverInput) -> ExternResult<Record> {
    collected(input.order_original_action, Some(input.code))
}

fn collected(order_ref: ActionHash, code: Option<PinSecret>) -> ExternResult<Record> {
    let order_ref = original_action_of(order_ref)?;
    let (version, mut order) = current(&order_ref)?;
    let me = me()?;
    let by_store = code.is_some();
    let allowed = if by_store { order.merchant == me } else { order.requester == me };
    if !allowed || order.status != DeliveryStatus::Collecting {
        return Err(guest(if by_store { "Only the store hands over an order its customer is collecting." } else { "Only the customer confirms they've collected it." }));
    }
    if let Some(code) = &code {
        if !code.opens(&order.pin_commitment) {
            return Err(guest("That isn't this customer's code."));
        }
    }
    order.status = DeliveryStatus::Collected;
    order.collection_proof = code;
    let done = write(&version, order.clone())?;
    retire(&OrderParties::delivery(&order_ref, &order)?)?;
    // The customer has it, so the store's order is complete -- credited by
    // the customer; when the store handed it over, the customer's app
    // records it on seeing so (`record_what_changed`).
    if !by_store {
        let _ = record_reputation_event(&order.merchant, ReputationTargetWire::Store(order.catalog_ref.clone()), order_ref, ReputationEventKindWire::OrderCompleted, done.action_address().clone());
    }
    Ok(done)
}

/// The store recording an order its customer never came for, once the
/// collection window has passed: it keeps the food's price.
#[hdk_extern]
pub fn mark_not_collected(input: TimedStepInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (version, order) = current(&order_ref)?;
    if order.merchant != me()? || order.status != DeliveryStatus::Collecting {
        return Err(guest("Only the store records an order it was waiting to hand over as uncollected."));
    }
    if !past(collect_by(&version.record, &order), true, input.beacon.as_ref())? {
        return Err(guest("The customer still has time to collect it."));
    }
    cancel_proved(&version, order, &order_ref, Cancellation::NotCollected, input.beacon)
}

/// When a customer collecting `order` (at `record`) must come by: the
/// network's window from when it's due ready, or from the store recording
/// them collecting it if that's later.
pub(crate) fn collect_by(record: &Record, order: &DeliveryOrder) -> Timestamp {
    Timestamp::from_micros(waits_from(record.action().timestamp(), order.ready_by).as_micros().saturating_add(handshake_governance::collection_window().as_micros() as i64))
}

/// The customer closing an order its store has gone silent on -- one it
/// owes its next step, unmoved past `handshake_governance::order_lapse` --
/// with proof of the time, which validation checks: nobody's charged but
/// the store, which pays a driver it had checked in, and it counts against
/// the store.
#[hdk_extern]
pub fn lapse_delivery_order(input: TimedStepInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (version, order) = current(&order_ref)?;
    if order.requester != me()? {
        return Err(guest("Only the customer closes an order its store has gone silent on."));
    }
    match Version::of(version.record.clone()).map(|v| lineage::lapses_at(&v)).transpose()?.flatten() {
        Some(lapses) if past(lapses, true, input.beacon.as_ref())? => {}
        Some(_) => return Err(guest("The store still has time to answer for this order.")),
        None => return Err(guest("This order isn't waiting on its store.")),
    }
    cancel_proved(&version, order, &order_ref, Cancellation::Lapsed, input.beacon)
}

/// The driver saying nobody came to take the order: at the drop-off, once
/// they've recorded arriving (their drop-off handoff, which tells the
/// customer) and waited the network's wait since -- with proof of the time,
/// which validation checks. The customer can still take it, or dispute it;
/// otherwise the store upholds it once their report window has run
/// (`issues::decide_order`), and it's paid as delivered.
#[hdk_extern]
pub fn customer_not_here(input: TimedStepInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (version, mut order) = current(&order_ref)?;
    let me = me()?;
    if order.status != DeliveryStatus::PickedUp || driver_of(&order)?.map(|(_, bid)| bid.bidder) != Some(me.clone()) {
        return Err(guest("Only the order's driver, with it in hand, says nobody came to take it."));
    }
    let arrival = arrival_of(&order_ref, &me)?.ok_or(guest("Record that you've arrived first: hand it over at the door, and the customer is told you're there."))?;
    // With a photo of the door: the customer's evidence, and the store's if
    // they dispute it. (Sealed to the customer, so only the apps check it.)
    let evidence: Option<attestation_types::HandoffEvidence> = call_local("attestation", "get_handoff_evidence", arrival.action_address().clone())?.map_err(|why| guest(format!("couldn't read your arrival: {why}")))?;
    let photo = evidence.map(|e| e.photo_data_uri).filter(|photo| !photo.is_empty());
    let photo = photo.ok_or(guest("Take a photo of the door as you arrive: it's what shows the customer, and the store, that you were there."))?;
    let waited_until = Timestamp::from_micros(arrival.action().timestamp().as_micros().saturating_add(handshake_governance::dropoff_wait().as_micros() as i64));
    if !past(waited_until, true, input.beacon.as_ref())? {
        return Err(guest("The customer still has time to come to the door."));
    }
    let merchant = order.merchant.clone();
    order.status = DeliveryStatus::Unanswered;
    order.delivery_receipts = vec![arrival.action_address().clone()];
    order.beacon = input.beacon;
    let unanswered = write(&version, order)?;
    // The store sees the door too, should the customer say they were there.
    crate::never_arrived::give_store_evidence(&order_ref, version.record.action_address(), &merchant, ArrivalNote::DoorPhoto(photo))?;
    Ok(unanswered)
}

/// The caller's latest drop-off handoff for `order_ref` that no code or
/// door completes: their record of arriving.
fn arrival_of(order_ref: &ActionHash, driver: &AgentPubKey) -> ExternResult<Option<Record>> {
    let legs: Vec<Record> = call_local("attestation", "get_legs_for_order", order_ref.clone())?.map_err(|why| guest(format!("couldn't read your handoffs: {why}")))?;
    Ok(legs
        .into_iter()
        .filter(|record| {
            record.entry().to_app_option::<attestation_types::Leg>().ok().flatten().is_some_and(|leg| {
                leg.kind == attestation_types::LegKind::CustomerHandoff && &leg.from == driver && record.action().author() == driver && leg.revealed_pin.is_none() && !leg.left_at_door
            })
        })
        .max_by_key(|record| record.action().timestamp()))
}

/// Cancels a delivery for `reason`, with the proof of the time it needs.
pub(crate) fn cancel_proved(current: &EntryVersion, mut order: DeliveryOrder, order_ref: &ActionHash, reason: Cancellation, beacon: Option<Beacon>) -> ExternResult<Record> {
    order.status = DeliveryStatus::Cancelled;
    order.cancellation = Some(reason);
    order.beacon = beacon;
    let cancelled = write(current, order.clone())?;
    retire(&OrderParties::delivery(order_ref, &order)?)?;
    crate::orders::record_cancellation(&cancelled, order_ref)?;
    Ok(cancelled)
}
