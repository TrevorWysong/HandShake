//! Link validation for every dispatch link type: each link must agree with
//! the order or bid it points at, and be authored by the agent who
//! legitimately creates it. The order queues' rules live in `order_queues`.

use super::*;
use crate::order_queues::{validate_queue_link_create, validate_queue_link_delete};
use handshake_integrity_support::{decode, invalid, linked_record, original_creation, path_hash, require};

/// The parts of a create- or delete-link op these checks look at. For a
/// delete, `base`/`target` come from the link being deleted and `author` is
/// whoever is deleting it; `timestamp` is the op's own action timestamp.
pub struct OpLinkFields<'a> {
    pub link_type: &'a LinkTypes,
    pub base: &'a AnyLinkableHash,
    pub target: &'a AnyLinkableHash,
    pub tag: &'a LinkTag,
    pub author: &'a AgentPubKey,
    pub timestamp: Timestamp,
}

/// How long an open-order anchor bucket is:
/// otherwise `open_order_geohash.{geohash}` accumulates one never-deleted
/// link per order, forever, and every discovery read walks the entire
/// history of every order ever placed in that cell. 5 minutes: generous
/// enough that a slow-to-match order doesn't fall out of the *current*
/// bucket before resolving.
pub const OPEN_ORDER_BUCKET_MILLIS: i64 = 300_000;

/// The discovery anchor drivers poll for open orders dropping off in
/// `geohash` that were published during `bucket`.
pub fn open_order_anchor(geohash: &str, bucket: i64) -> String {
    format!("open_order_geohash.{geohash}.{bucket}")
}

pub fn validate_create_link(link: OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    match link.link_type {
        // Validated as a version (`validate`).
        LinkTypes::Version => invalid("a version link is validated as one"),
        LinkTypes::StoreToActiveOrder
        | LinkTypes::StoreHistoryPath
        | LinkTypes::StoreHistoryToOrder
        | LinkTypes::CustomerToActiveOrder
        | LinkTypes::CustomerHistoryPath
        | LinkTypes::CustomerHistoryToOrder
        | LinkTypes::DriverToActiveDelivery => validate_queue_link_create(link),
        LinkTypes::OrderToBid => {
            let Some(bid) = target_entry::<Bid>(link.target)? else { return invalid("target is not a Bid") };
            require(
                link.author == &bid.bidder && link.base == &AnyLinkableHash::from(original_creation(bid.order_ref)?),
                "a bid may only be linked by its bidder, under its own order's identity",
            )
        }
        LinkTypes::OpenOrderGeohashAnchor => validate_open_order_link(&link),
        LinkTypes::OrderToIssue | LinkTypes::IssueToResponse | LinkTypes::OrderToDecision | LinkTypes::OrderToCollectRequest | LinkTypes::OrderToDropoffShare => validate_issue_link(&link),
        LinkTypes::StoreToReport => validate_report_link(&link),
        LinkTypes::StoreToNewcomerCard => validate_newcomer_card_link(&link),
        LinkTypes::DriverToVerification => crate::verification::validate_verification_link(&link),
        LinkTypes::OrderToAppeal | LinkTypes::ArbiterToAppeal | LinkTypes::AppealToAnswer | LinkTypes::AppealToRuling | LinkTypes::StoreOwnerToRuling | LinkTypes::StoreOwnerToAppeal => crate::appeals::validate_appeal_link(&link),
        LinkTypes::OwnerToTemplate => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            require(
                decode::<RecurringOrderTemplate>(&record).is_some() && matches!(record.action().data, ActionData::Create(_)) && record.action().author() == link.author && link.base == &AnyLinkableHash::from(link.author.clone()),
                "a standing order is listed only by its owner, under their own key",
            )
        }
        // The customer's confirmation, under their order.
        // A payment record, by its author, under its own order.
        LinkTypes::OrderToPayment => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            let order = crate::payments::order_of_payment(&record)?;
            require(record.action().author() == link.author && order.is_some_and(|order| link.base == &AnyLinkableHash::from(order)), "a payment record is linked by its author, under its own order")
        }
        // A card withdrawn, by its payer, under the payee it was kept with.
        LinkTypes::AgentToForgottenCard => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            let ours = record.action().author() == link.author && decode::<SavedCardForgotten>(&record).is_some_and(|f| link.base == &AnyLinkableHash::from(f.payee));
            require(ours, "a withdrawn card is linked by its payer, under the payee it was kept with")
        }
        // A no-show's evidence, by whoever gave it, under its order.
        LinkTypes::OrderToArrivalEvidence => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            let ours = record.action().author() == link.author && decode::<ArrivalEvidence>(&record).is_some_and(|e| link.base == &AnyLinkableHash::from(e.order));
            require(ours, "evidence is linked by whoever gave it, under its order")
        }
        // A driver's vehicle, by that driver, under its order, tagged with
        // their key -- how the customer finds their current driver's.
        LinkTypes::OrderToVehicleShare => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            let ours = record.action().author() == link.author
                && link.tag.0 == link.author.get_raw_39()
                && decode::<VehicleShare>(&record).is_some_and(|s| link.base == &AnyLinkableHash::from(s.order));
            require(ours, "a vehicle is linked by its driver, under its order, tagged with their key")
        }
        // How an agent is paid, under their own key.
        LinkTypes::AgentToPaymentProfile => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            let own = decode::<PaymentProfile>(&record).is_some() && record.action().author() == link.author && link.base == &AnyLinkableHash::from(link.author.clone());
            require(own, "a payment profile is linked by its own agent, under their key")
        }
        LinkTypes::OrderToConfirmation => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            // By its type: a `DeclineNoted` has the same fields, and decodes as one.
            let confirmation = handshake_integrity_support::chain::creates_one_of(record.action(), &[UnitEntryTypes::OrderConfirmation.try_into()?]);
            let ours = confirmation && decode::<OrderConfirmation>(&record).is_some_and(|c| link.base == &AnyLinkableHash::from(c.order)) && record.action().author() == link.author;
            require(ours, "a confirmation is linked by its customer, under its order")
        }
        // Only the order's store counts it, under the promo it cites.
        LinkTypes::PromoToOrder => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            if !matches!(record.action().data, ActionData::Create(_)) {
                return invalid("a promo's use links an order by its original action");
            }
            let cited = decode::<DeliveryOrder>(&record).map(|o| (o.merchant, o.promo_code_ref)).or_else(|| decode::<PickupOrder>(&record).map(|o| (o.merchant, o.promo_code_ref)));
            let Some((merchant, Some(promo))) = cited else { return invalid("a promo's use links an order that cites it") };
            let promo = handshake_integrity_support::original_creation(promo)?;
            require(&merchant == link.author && link.base == &AnyLinkableHash::from(promo), "a promo's use is counted by the order's store, under the promo the order cites")
        }
        // Only the order's store records a bag it sold, under a bag the
        // order has.
        LinkTypes::BagToOrder => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            if !matches!(record.action().data, ActionData::Create(_)) {
                return invalid("a bag's sale links an order by its original action");
            }
            let order = decode::<DeliveryOrder>(&record).map(|o| (o.merchant, o.lines)).or_else(|| decode::<PickupOrder>(&record).map(|o| (o.merchant, o.lines)));
            let Some((merchant, lines)) = order else { return invalid("a bag's sale links an order") };
            let on_it = lines.iter().any(|line| link.base == &AnyLinkableHash::from(line.item_ref.clone()));
            require(&merchant == link.author && on_it, "a goodie bag's sale is recorded by the order's store, under a bag on the order")
        }
    }
}

/// An order is published for discovery by whoever opens it -- its store,
/// accepting it, or whoever releases its driver -- only in its Open form,
/// and only under its own dropoff
/// cell's anchor for when it was published. That time isn't recorded on the
/// entry, but it's never after this link and at most moments before it, so
/// it falls in this link's bucket or the one before.
fn validate_open_order_link(link: &OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    // Anchors are computed, never walked: only orders are linked under one.
    let Some(record) = linked_record(link.target)? else { return invalid("an open-order anchor links only orders") };
    let Some(order) = decode::<DeliveryOrder>(&record) else { return invalid("target is not a DeliveryOrder") };
    // Whoever opened this version publishes it: the store accepting the
    // order, or -- after a driver leaves it -- whoever released them (the
    // version's own validation checked they could).
    if link.author != record.action().author() || order.status != DeliveryStatus::Open {
        return invalid("an open order is published by whoever opened that version of it");
    }
    // Under its store's cell: drivers are offered what's near the restaurant.
    let cell = match crate::checks::open_order_cell(&order)? {
        Ok(cell) => cell,
        Err(reason) => return invalid(&reason),
    };
    let bucket = handshake_types::time_bucket(link.timestamp.as_millis(), OPEN_ORDER_BUCKET_MILLIS);
    let allowed = [bucket, bucket - 1].map(|b| path_hash(open_order_anchor(&cell, b)));
    for expected in allowed {
        if link.base == &expected? {
            return Ok(ValidateCallbackResult::Valid);
        }
    }
    invalid("an open order may only be published under its store's cell's current anchor")
}

pub fn validate_delete_link(link: OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    match link.link_type {
        LinkTypes::OpenOrderGeohashAnchor | LinkTypes::OrderToBid | LinkTypes::OwnerToTemplate | LinkTypes::PromoToOrder | LinkTypes::BagToOrder | LinkTypes::OrderToConfirmation | LinkTypes::OrderToPayment | LinkTypes::AgentToForgottenCard | LinkTypes::OrderToArrivalEvidence | LinkTypes::OrderToVehicleShare => invalid("this dispatch link type can't be deleted"),
        // Disconnecting a processor.
        LinkTypes::AgentToPaymentProfile => require(link.base == &AnyLinkableHash::from(link.author.clone()), "only its own agent unlinks how they're paid"),
        LinkTypes::DriverToVerification => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            require(record.action().author() == link.author, "only its verifier unlinks a verification")
        }
        LinkTypes::OrderToIssue | LinkTypes::IssueToResponse | LinkTypes::OrderToDecision | LinkTypes::OrderToCollectRequest | LinkTypes::OrderToDropoffShare => invalid("an order's issues, requests and settlement are a permanent record"),
        LinkTypes::StoreToNewcomerCard => invalid("a card that took a store's first-order deal stays on its record"),
        // The report itself stays under its order; only the store's
        // reminder of it goes, cleared by the store.
        LinkTypes::StoreToReport => {
            let Some(store) = linked_record(link.base)? else { return invalid("a report is listed under a store") };
            require(store.action().author() == link.author, "only the store clears a report from its list")
        }
        LinkTypes::OrderToAppeal | LinkTypes::ArbiterToAppeal | LinkTypes::AppealToAnswer | LinkTypes::AppealToRuling | LinkTypes::StoreOwnerToRuling | LinkTypes::StoreOwnerToAppeal => invalid("an appeal is a permanent record"),
        _ => validate_queue_link_delete(link),
    }
}

/// The entry a data link points at, decoded as `T`. `None` for a path node
/// or a different entry type.
fn target_entry<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(target: &AnyLinkableHash) -> ExternResult<Option<T>> {
    Ok(linked_record(target)?.and_then(|record| decode::<T>(&record)))
}

/// A card that took a store's first-order deal: listed by the store's owner,
/// under the store, naming an order placed there, tagged with a 32-byte
/// digest of the card (the fingerprint itself is never published).
fn validate_newcomer_card_link(link: &OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    let Some(store) = link.base.clone().into_action_hash() else { return invalid("a store's deal cards are listed under the store") };
    let owned = must_get_valid_record(store.clone())?.action().author() == link.author;
    let Some(order) = linked_record(link.target)? else { return invalid("a deal card names the order that took the deal") };
    let catalog = decode::<DeliveryOrder>(&order).map(|o| o.catalog_ref).or_else(|| decode::<PickupOrder>(&order).map(|o| o.catalog_ref));
    require(owned && catalog == Some(store) && link.tag.0.len() == 32, "only a store's owner lists the cards that took its first-order deal, each on an order placed there")
}

/// A customer's report, listed under the store its order was placed at by
/// whoever reported it, tagged with that order.
fn validate_report_link(link: &OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = linked_record(link.target)? else { return invalid("a report link targets a report") };
    let Some(issue) = decode::<dispatch_types::ItemIssue>(&record) else { return invalid("a report link targets a report") };
    if record.action().author() != link.author || link.tag.0 != issue.order.get_raw_39().to_vec() {
        return invalid("a report is listed by whoever made it, tagged with its order");
    }
    let order = must_get_valid_record(issue.order.clone())?;
    let catalog = decode::<DeliveryOrder>(&order).map(|o| o.catalog_ref).or_else(|| decode::<PickupOrder>(&order).map(|o| o.catalog_ref));
    require(catalog.is_some_and(|c| link.base == &AnyLinkableHash::from(c)), "a report is listed under the store its order was placed at")
}

/// An issue, a store's answer, and the store's decisions are each found
/// under the order (or issue) they're about, linked by whoever wrote them.
fn validate_issue_link(link: &OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    use dispatch_types::{IssueResponse, ItemIssue, ItemSettlement, OrderOutcome};
    let Some(record) = linked_record(link.target)? else { return invalid("this link must target a record") };
    let written_by_author = record.action().author() == link.author;
    let expected_base: Option<AnyLinkableHash> = match link.link_type {
        LinkTypes::OrderToIssue => decode::<ItemIssue>(&record).map(|i| i.order.into()),
        LinkTypes::OrderToCollectRequest => decode::<CollectRequest>(&record).map(|r| r.order.into()),
        LinkTypes::OrderToDropoffShare => decode::<DropoffShare>(&record).map(|r| r.order.into()),
        LinkTypes::IssueToResponse => decode::<IssueResponse>(&record).map(|r| r.issue.into()),
        LinkTypes::OrderToDecision => match (decode::<OrderOutcome>(&record), decode::<ItemSettlement>(&record)) {
            (Some(outcome), _) => Some(outcome.order.into()),
            (None, Some(settlement)) => Some(settlement.order.into()),
            _ => None,
        },
        _ => None,
    };
    match expected_base {
        Some(base) => require(written_by_author && &base == link.base, "an issue record is linked under what it's about, by whoever wrote it"),
        None => invalid("this link's target isn't the record its link type indexes"),
    }
}
