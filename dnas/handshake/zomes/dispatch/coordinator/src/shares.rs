//! What a delivery's customer and driver share with each other once the
//! driver commits, sealed so nobody else can read it: the customer's exact
//! drop-off, and the driver's vehicle -- each through a record of its own,
//! linked from the order, so sharing never races another party's step.

use crate::deliveries::{current, driver_of, me};
use dispatch_integrity::*;
use hdk::prelude::*;
use handshake_coordinator_support::{call_local, decode_or, guest, original_action_of};

// --- the customer shares their address ---

/// The customer's app sharing their exact drop-off with a driver who's
/// committed -- sealed to that driver alone. Done as soon as it hears they
/// have (`upkeep`), never before: a driver with nothing at stake never
/// learns where anyone lives.
#[hdk_extern]
pub fn share_address(order_ref: ActionHash) -> ExternResult<ActionHash> {
    let order_ref = original_action_of(order_ref)?;
    let (version, order) = current(&order_ref)?;
    let me = me()?;
    if order.requester != me {
        return Err(guest("Only the order's customer shares its address."));
    }
    let Some(driver) = owed_driver(&order_ref, &order)? else { return Err(guest("There's no committed driver waiting for the address.")) };
    let dropoff: DropoffDetails = handshake_coordinator_support::open(&me, &order.sealed_dropoff)?.ok_or(guest("Couldn't open your address on this device."))?;
    let share = DropoffShare { order: order_ref.clone(), committed: version.record.action_address().clone(), sealed: handshake_coordinator_support::seal(&driver, &dropoff)?, driver: driver.clone() };
    let action = create_entry(&EntryTypes::DropoffShare(share))?;
    create_link(order_ref, action.clone(), LinkTypes::OrderToDropoffShare, driver.get_raw_39().to_vec())?;
    Ok(action)
}

/// The committed driver the customer's app owes the address, if any: the
/// order's driver, committed, with no share for them yet.
pub(crate) fn owed_driver(order_ref: &ActionHash, order: &DeliveryOrder) -> ExternResult<Option<AgentPubKey>> {
    let active = matches!(order.status, DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed | DeliveryStatus::DriverAtStore | DeliveryStatus::PickedUp);
    if !active || order.collateral_payment.is_none() {
        return Ok(None);
    }
    let Some((_, bid)) = driver_of(order)? else { return Ok(None) };
    Ok(dropoff_share_for(order_ref, &bid.bidder)?.is_none().then_some(bid.bidder))
}

/// The address the customer shared with `driver` for an order, if they have.
pub(crate) fn dropoff_share_for(order_ref: &ActionHash, driver: &AgentPubKey) -> ExternResult<Option<DropoffShare>> {
    let mut query = LinkQuery::try_new(order_ref.clone(), LinkTypes::OrderToDropoffShare)?;
    query.tag_prefix = Some(LinkTag::new(driver.get_raw_39().to_vec()));
    for link in get_links(query, GetStrategy::default())? {
        let Some(target) = link.target.into_action_hash() else { continue };
        let share = get(target, GetOptions::default())?.and_then(|record| handshake_coordinator_support::decode_or::<DropoffShare>(&record));
        if let Some(share) = share.filter(|s| &s.order == order_ref && &s.driver == driver) {
            return Ok(Some(share));
        }
    }
    Ok(None)
}

// --- the driver shares their vehicle ---

/// The committed driver's app sharing their vehicle with the order's
/// customer -- sealed to them alone -- so they know who to look for. Done as
/// soon as the driver commits (`tend_driver_deliveries`), in a call of its
/// own; a driver who hasn't saved one has nothing to share.
#[hdk_extern]
pub fn share_vehicle(order_ref: ActionHash) -> ExternResult<Option<ActionHash>> {
    let order_ref = original_action_of(order_ref)?;
    let (version, order) = current(&order_ref)?;
    if !owes_vehicle(&order_ref, &order)? {
        return Err(guest("Only the order's committed driver shares their vehicle, once."));
    }
    let Some(vehicle) = call_local::<_, Option<Record>>("profiles", "get_my_vehicle", ())?.map_err(guest)? else { return Ok(None) };
    let Some(vehicle) = decode_or::<VehicleDetails>(&vehicle) else { return Ok(None) };
    let share = VehicleShare { order: order_ref.clone(), committed: version.record.action_address().clone(), sealed: handshake_coordinator_support::seal_chunked(&order.requester, &vehicle)? };
    let action = create_entry(&EntryTypes::VehicleShare(share))?;
    create_link(order_ref, action.clone(), LinkTypes::OrderToVehicleShare, me()?.get_raw_39().to_vec())?;
    Ok(Some(action))
}

/// Whether the caller is the order's committed driver, and hasn't shared
/// their vehicle with its customer yet.
pub(crate) fn owes_vehicle(order_ref: &ActionHash, order: &DeliveryOrder) -> ExternResult<bool> {
    let active = matches!(order.status, DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed | DeliveryStatus::DriverAtStore | DeliveryStatus::PickedUp);
    if !active || order.collateral_payment.is_none() {
        return Ok(false);
    }
    let me = me()?;
    let Some((_, bid)) = driver_of(order)? else { return Ok(false) };
    Ok(bid.bidder == me && vehicle_share_for(order_ref, &me)?.is_none())
}

/// The vehicle `driver` shared for an order, if they have.
fn vehicle_share_for(order_ref: &ActionHash, driver: &AgentPubKey) -> ExternResult<Option<VehicleShare>> {
    let mut query = LinkQuery::try_new(order_ref.clone(), LinkTypes::OrderToVehicleShare)?;
    query.tag_prefix = Some(LinkTag::new(driver.get_raw_39().to_vec()));
    let mut links = get_links(query, GetStrategy::default())?;
    links.sort_by_key(|link| std::cmp::Reverse(link.timestamp));
    for link in links.into_iter().filter(|link| &link.author == driver) {
        let Some(target) = link.target.into_action_hash() else { continue };
        if let Some(share) = get(target, GetOptions::default())?.and_then(|record| decode_or::<VehicleShare>(&record)).filter(|s| &s.order == order_ref) {
            return Ok(Some(share));
        }
    }
    Ok(None)
}

/// The order's driver's vehicle, for its customer: once that driver has
/// committed and shared it; None for anyone else.
#[hdk_extern]
pub fn get_driver_vehicle(order_ref: ActionHash) -> ExternResult<Option<VehicleDetails>> {
    let order_ref = original_action_of(order_ref)?;
    let (_, order) = current(&order_ref)?;
    if order.requester != me()? {
        return Ok(None);
    }
    let Some((_, bid)) = driver_of(&order)? else { return Ok(None) };
    let Some(share) = vehicle_share_for(&order_ref, &bid.bidder)? else { return Ok(None) };
    // Checked on the way out, as the network checks a driver's own copy: a
    // modified client could seal anything.
    use handshake_coordinator_support::{at_most, checked_photo};
    use handshake_integrity_support::limits::{MAX_LICENSE_PLATE_CHARS, MAX_VEHICLE_CHARS};
    Ok(handshake_coordinator_support::open_chunked::<VehicleDetails>(&bid.bidder, &share.sealed)?.map(|v| VehicleDetails {
        vehicle_description: at_most(v.vehicle_description, MAX_VEHICLE_CHARS),
        license_plate: at_most(v.license_plate, MAX_LICENSE_PLATE_CHARS),
        photo_data_uri: checked_photo(v.photo_data_uri),
    }))
}
