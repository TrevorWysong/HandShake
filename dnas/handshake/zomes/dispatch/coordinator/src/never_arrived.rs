//! A delivery that never arrived: the customer says so -- of an order on
//! its way, or one its driver says nobody came for -- and the store decides
//! (`issues::decide_order`). Until it has, a driver running late can still
//! complete the delivery with proof the customer has it.

use crate::orders::{record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use dispatch_integrity::*;
use hdk::prelude::*;
use handshake_coordinator_support::{call_local, decode_or, guest, open, open_chunked, original_action_of, resolve_latest_decoded, resolve_version_decoded, seal_chunked, update_version, written};

/// The customer saying their delivery never arrived -- once the driver has
/// picked it up and before it's delivered, or that they were there when its
/// driver says nobody came. Recorded against the driver (informational:
/// only the store's decision counts against them).
#[hdk_extern]
pub fn claim_never_arrived(order_original_action: ActionHash) -> ExternResult<Record> {
    let (current, mut order): (_, DeliveryOrder) = resolve_version_decoded(order_original_action.clone(), "DeliveryOrder")?;
    if order.requester != agent_info()?.agent_initial_pubkey {
        return Err(guest("Only the order's customer can say it never arrived."));
    }
    if !matches!(order.status, DeliveryStatus::PickedUp | DeliveryStatus::Unanswered) {
        return Err(guest("You can say an order never arrived once your driver has picked it up, and until it's delivered."));
    }
    let bid_ref = order.accepted_bid.clone().ok_or(guest("This order has no driver yet."))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(bid_ref, "Bid")?;
    // Saying they were there when the driver says nobody came: the store
    // learns how far from the door the driver recorded being.
    if let Some(metres) = arrived_metres(&order)? {
        give_store_evidence(&order_original_action, current.record.action_address(), &order.merchant, ArrivalNote::ArrivedMetres(metres))?;
    }
    order.status = DeliveryStatus::Disputed;
    let updated = update_version(&current, &EntryTypes::DeliveryOrder(order), LinkTypes::Version)?;
    record_reputation_event(&bid.bidder, ReputationTargetWire::Driver(bid.bidder.clone()), order_original_action, ReputationEventKindWire::DisputeRaised, updated.clone())?;
    written(updated)
}

/// How far from the customer's drop-off point their driver recorded
/// arriving, to the metre -- worked out on the customer's device, the only
/// one holding both -- when the driver says nobody came.
fn arrived_metres(order: &DeliveryOrder) -> ExternResult<Option<u32>> {
    let Some(arrival) = order.delivery_receipts.first().filter(|_| order.status == DeliveryStatus::Unanswered) else { return Ok(None) };
    let evidence: Option<attestation_types::HandoffEvidence> = call_local("attestation", "get_handoff_evidence", arrival.clone())?.ok().flatten();
    let dropoff: Option<DropoffDetails> = open(&agent_info()?.agent_initial_pubkey, &order.sealed_dropoff)?;
    Ok(evidence.zip(dropoff).map(|(evidence, dropoff)| (handshake_types::distance_km(evidence.geo, dropoff.point) * 1000.0).round().min(u32::MAX as f64) as u32))
}

/// Seals `note` to the order's store, as evidence for a no-show it may be
/// asked to decide; `version` is one showing the caller a party to it.
pub(crate) fn give_store_evidence(order_ref: &ActionHash, version: &ActionHash, merchant: &AgentPubKey, note: ArrivalNote) -> ExternResult<()> {
    let evidence = ArrivalEvidence { order: order_ref.clone(), version: version.clone(), sealed: seal_chunked(merchant, &note)? };
    let hash = create_entry(&EntryTypes::ArrivalEvidence(evidence))?;
    create_link(order_ref.clone(), hash, LinkTypes::OrderToArrivalEvidence, ())?;
    Ok(())
}

/// What the store has been told of a no-show: its driver's photo of the
/// door, and how far from the drop-off point the customer's app says the
/// driver recorded arriving.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct StoreArrivalEvidence {
    pub door_photo: Option<String>,
    pub arrived_metres: Option<u32>,
}

/// A no-show's evidence, for its store; empty for anyone else. Each read
/// only from the party it's theirs to give -- the photo from the order's
/// driver, the distance from its customer -- and only the first each gave.
#[hdk_extern]
pub fn arrival_evidence(order_original_action: ActionHash) -> ExternResult<StoreArrivalEvidence> {
    let order_ref = original_action_of(order_original_action)?;
    let (_, order): (_, DeliveryOrder) = resolve_version_decoded(order_ref.clone(), "DeliveryOrder")?;
    let mut found = StoreArrivalEvidence::default();
    if order.merchant != agent_info()?.agent_initial_pubkey {
        return Ok(found);
    }
    let driver = match &order.accepted_bid {
        Some(bid) => Some(resolve_latest_decoded::<Bid>(bid.clone(), "Bid")?.1.bidder),
        None => None,
    };
    let mut records = Vec::new();
    for link in get_links(LinkQuery::try_new(order_ref.clone(), LinkTypes::OrderToArrivalEvidence)?, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        records.extend(get(hash, GetOptions::default())?);
    }
    records.sort_by_key(|record| record.action().timestamp());
    for record in records {
        let Some(evidence) = decode_or::<ArrivalEvidence>(&record).filter(|e| e.order == order_ref) else { continue };
        let author = record.action().author();
        let Some(note) = open_chunked::<ArrivalNote>(author, &evidence.sealed)? else { continue };
        match note {
            ArrivalNote::DoorPhoto(photo) if driver.as_ref() == Some(author) && found.door_photo.is_none() && handshake_integrity_support::image_problem(&photo).is_none() => found.door_photo = Some(photo),
            ArrivalNote::ArrivedMetres(metres) if author == &order.requester && found.arrived_metres.is_none() => found.arrived_metres = Some(metres),
            _ => {}
        }
    }
    Ok(found)
}
