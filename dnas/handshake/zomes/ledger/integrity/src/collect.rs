//! Collecting a part of a hold: on what basis -- the store's decision, a
//! cancellation, the customer's own word -- and at what stage of the order.

use super::*;

/// What entitles a collection.
pub(crate) enum Basis {
    /// The store's decision that the order reached its customer, with the
    /// bid that delivered it.
    Delivered { bid: Option<ActionHash> },
    /// The store's decision that it never did, with the bid that had it.
    NotDelivered { bid: Option<ActionHash> },
    /// The store's settlement of the food, with the refund it names.
    Settled { refund: u64 },
    /// The order cancelled.
    Cancelled(Cancelled),
    /// A part waived back to its payer.
    Waived { by: AgentPubKey, hold: ActionHash, portion: Portion },
    /// The driver behind `bid` leaving before pickup -- by their own choice
    /// or the store's -- whether they were calling the store late
    /// (`lineage::is_store_late_release`), when they leave paid in full, and
    /// whether they left from the counter, checked in: then the store's own
    /// chain says they came for the food, and they never answer for it.
    Released { bid: ActionHash, store_late: bool, at_store: bool },
    /// After the driver behind `bid` left, the store confirming another
    /// driver or recording the customer collecting it: someone else is
    /// getting the food to them, so the first no longer answers for it.
    Replaced { bid: ActionHash },
}

/// An order's cancellation, as the parts of its holds turn on it.
pub(crate) struct Cancelled {
    pub(crate) by: Cancellation,
    /// How far the order had got.
    pub(crate) from: Stage,
    /// Whether the store had started cooking it.
    pub(crate) cooking: bool,
    /// The driver's bid the order had, if any.
    pub(crate) bid: Option<ActionHash>,
    /// For `NoDriver`: the bid of the driver who answers for the food.
    pub(crate) liable: Option<ActionHash>,
    /// The version that cancels it, and who wrote it.
    pub(crate) version: ActionHash,
    pub(crate) author: AgentPubKey,
}

/// How far an order had got when it was cancelled.
#[derive(PartialEq, Eq)]
pub(crate) enum Stage {
    /// Not yet accepted by the store.
    Waiting,
    /// Accepted; no driver yet (or a pickup order being prepared).
    Accepted,
    /// A driver assigned, not yet at the store.
    DriverAssigned,
    /// The driver checked in at the store.
    AtStore,
    Other,
}

pub(crate) fn delivery_stage(status: &DeliveryStatus) -> Stage {
    match status {
        DeliveryStatus::Scheduled | DeliveryStatus::Placed => Stage::Waiting,
        // Collecting: no driver, the customer coming for it.
        DeliveryStatus::Open | DeliveryStatus::Collecting => Stage::Accepted,
        DeliveryStatus::BidAccepted | DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed => Stage::DriverAssigned,
        DeliveryStatus::DriverAtStore => Stage::AtStore,
        _ => Stage::Other,
    }
}

pub(crate) fn pickup_stage(status: &PickupStatus) -> Stage {
    match status {
        PickupStatus::Placed => Stage::Waiting,
        PickupStatus::MerchantConfirmed | PickupStatus::ReadyForPickup => Stage::Accepted,
        _ => Stage::Other,
    }
}

/// The bid a hold is for, if it's for a driver.
pub(crate) fn bid_of(purpose: &HoldPurpose) -> Option<&ActionHash> {
    match purpose {
        HoldPurpose::Food => None,
        HoldPurpose::DriverPay { bid } | HoldPurpose::Subsidy { bid } | HoldPurpose::Collateral { bid } => Some(bid),
    }
}

/// The bid behind the version of `order` at `version_ref`.
pub(crate) fn bid_at(order: &ActionHash, version_ref: &ActionHash) -> ExternResult<Option<ActionHash>> {
    if &original_creation(version_ref.clone())? != order {
        return Ok(None);
    }
    Ok(Version::at(version_ref)?.and_then(|v| v.order.accepted_bid))
}

/// What `basis` entitles, for a hold on `hold.order` -- or why it doesn't.
/// The store's decisions are validated as its own (`dispatch_integrity`):
/// one each per order, by its store.
pub(crate) fn basis_of(basis_ref: &ActionHash, hold: &HoldContext) -> ExternResult<Result<Basis, &'static str>> {
    let record = must_get_valid_record(basis_ref.clone())?;
    let author = record.action().author().clone();
    if let Some(LedgerEntry { kind: LedgerKind::Waive { hold: waived, portion }, .. }) = decode::<LedgerEntry>(&record) {
        return Ok(Ok(Basis::Waived { by: author, hold: waived, portion }));
    }
    if let Some(outcome) = decode::<OrderOutcome>(&record) {
        if outcome.order != hold.order {
            return Ok(Err("that outcome is another order's"));
        }
        return Ok(Ok(match outcome.outcome {
            Outcome::Delivered { proof } => Basis::Delivered { bid: bid_at(&hold.order, &proof)? },
            Outcome::NotDelivered { claim } => Basis::NotDelivered { bid: bid_at(&hold.order, &claim)? },
        }));
    }
    if let Some(settlement) = decode::<ItemSettlement>(&record) {
        return Ok(if settlement.order == hold.order { Ok(Basis::Settled { refund: settlement.refund }) } else { Err("that settlement is another order's") });
    }
    if original_creation(basis_ref.clone())? != hold.order {
        return Ok(Err("a collection's basis must be about the hold's own order"));
    }
    if !hold.terms.delivery {
        let Some(order) = decode::<PickupOrder>(&record) else { return Ok(Err("that isn't a basis for collecting")) };
        let from = prior_version::<PickupOrder>(&record)?.map(|p| pickup_stage(&p.status));
        return Ok(match (order.cancellation, from) {
            (Some(by), Some(from)) => {
                let cooking = from == Stage::Accepted;
                Ok(Basis::Cancelled(Cancelled { by, from, cooking, bid: None, liable: None, version: basis_ref.clone(), author: record.action().author().clone() }))
            }
            _ => Err("that version of the order doesn't entitle anyone to collect"),
        });
    }
    let Some(version) = Version::of(record) else { return Ok(Err("that isn't a basis for collecting")) };
    let Some(prior) = version.prior()? else { return Ok(Err("that version of the order doesn't entitle anyone to collect")) };
    // A driver leaving -- this hold's.
    let released = version.released(&prior).filter(|_| matches!(version.order.status, DeliveryStatus::Open | DeliveryStatus::Collecting));
    if let Some(bid) = released.clone().filter(|bid| Some(bid) == bid_of(&hold.purpose)) {
        // The store moving them on by recording the customer collecting it:
        // the food reaches the customer another way, so the driver no longer
        // answers for it.
        let collecting = version.order.status == DeliveryStatus::Collecting && version.author() == &hold.terms.merchant;
        if collecting && matches!(hold.purpose, HoldPurpose::Collateral { .. }) {
            return Ok(Ok(Basis::Replaced { bid }));
        }
        let at_store = prior.order.status == DeliveryStatus::DriverAtStore;
        return Ok(Ok(Basis::Released { bid, store_late: lineage::is_store_late_release(&version, &prior)?, at_store }));
    }
    // The store confirming a later driver than the one this hold is for, or
    // recording the customer collecting it.
    if let Some(bid) = bid_of(&hold.purpose) {
        let collecting = version.order.status == DeliveryStatus::Collecting && prior.order.status != DeliveryStatus::Collecting;
        let replacing = lineage::confirms_driver(&version, &prior) || collecting;
        if replacing && version.order.accepted_bid.as_ref() != Some(bid) && version.author() == &hold.terms.merchant {
            let left_earlier = lineage::find_back(version.clone(), |v, p| p.and_then(|p| v.released(p)).filter(|b| b == bid))?.is_some();
            // (The store's own chain shows it never ended the order on that
            // driver's account: `dispatch_integrity`'s no-driver rule.)
            if left_earlier {
                return Ok(Ok(Basis::Replaced { bid: bid.clone() }));
            }
        }
    }
    // The order cancelled.
    let Some(by) = version.order.cancellation.clone() else { return Ok(Err("that version of the order doesn't entitle anyone to collect")) };
    if prior.order.status == DeliveryStatus::Cancelled {
        return Ok(Err("that version of the order doesn't entitle anyone to collect"));
    }
    let liable = if by == Cancellation::NoDriver { lineage::liable_release(&prior)?.map(|(_, bid)| bid) } else { None };
    let author = version.author().clone();
    Ok(Ok(Basis::Cancelled(Cancelled { by, from: delivery_stage(&prior.order.status), cooking: prior.order.ready_by.is_some(), bid: prior.order.accepted_bid.clone(), liable, version: basis_ref.clone(), author })))
}

/// Whether the customer who cancelled had confirmed seeing their store
/// start on `order` before they did (`OrderConfirmation`, on their own
/// chain, behind the cancellation) -- and the store (`store`, collecting)
/// never called it off itself. Validation sees only the version a
/// cancellation updates, so a customer could cancel on an older one; their
/// own chain says what they knew when.
pub(crate) fn confirmed_cooking(c: &Cancelled, order: &ActionHash, store: &AgentPubKey, chain_top: &ActionHash) -> ExternResult<bool> {
    if !lineage::saw_start(&c.author, &c.version, order, store)? {
        return Ok(false);
    }
    Ok(!lineage::wrote_any(store, chain_top, order, |v| matches!(v.cancellation(), Some(Cancellation::ByStore(_))))?)
}

/// Whether the customer who cancelled had taken the driver behind
/// `hold_bid` -- accepted their bid, on their own chain, before cancelling
/// -- and the driver (`driver`, collecting) never left it themselves.
pub(crate) fn customer_took(c: &Cancelled, order: &ActionHash, hold_bid: Option<&ActionHash>, driver: &AgentPubKey, chain_top: &ActionHash) -> ExternResult<bool> {
    let Some(bid) = hold_bid else { return Ok(false) };
    if !lineage::wrote_any(&c.author, &c.version, order, |v| v.accepted_bid() == Some(bid))? {
        return Ok(false);
    }
    Ok(!lineage::wrote(driver, chain_top, order, |v, p| v.released(p).as_ref() == Some(bid))?)
}

/// The version an update replaced, as `T`.
pub(crate) fn prior_version<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &Record) -> ExternResult<Option<T>> {
    let ActionData::Update(update) = &record.action().data else { return Ok(None) };
    Ok(decode::<T>(&must_get_valid_record(update.original_action_address.clone())?))
}

/// Whether a customer's own updates and requests on `order` bind them to
/// paying for it: they cancelled it, or asked to collect it -- on any
/// branch of its history -- so a refund that rests on another party's
/// update can't also be theirs.
pub(crate) fn customer_bound(customer: &AgentPubKey, chain_top: &ActionHash, order: &ActionHash, by_collecting: bool) -> ExternResult<bool> {
    let cancelled = lineage::wrote(customer, chain_top, order, |v, p| v.order.cancellation == Some(Cancellation::ByCustomer) && p.order.status != DeliveryStatus::Cancelled)?;
    Ok(cancelled || (by_collecting && lineage::asked_to_collect(customer, chain_top, order)?))
}

pub(crate) fn validate_collect(entry: &LedgerEntry, hold_ref: &ActionHash, portion: Portion, basis_ref: &ActionHash, author: &AgentPubKey, at: Timestamp, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let hold = match hold_of(hold_ref)? {
        Ok(hold) => hold,
        Err(reason) => return invalid(reason),
    };
    let Some(share) = hold.shares.iter().find(|s| s.portion == portion).cloned() else {
        return invalid("that hold has no such part");
    };
    if at < hold.held_at {
        return invalid("a hold is decided after it's made");
    }
    if already_decided(author, prev_action, hold_ref, portion, hold.held_at)? {
        return invalid("that part of the hold has already been decided");
    }
    let basis = match basis_of(basis_ref, &hold)? {
        Ok(basis) => basis,
        Err(reason) => return invalid(reason),
    };
    let is_recipient = author == &share.recipient;
    let is_payer = author == &hold.payer;
    // What this collection takes: the whole part -- except the food at its
    // settlement, split between the store (the food less the refund) and
    // the customer (the refund).
    let expected = match (&portion, &basis) {
        (Portion::Food, Basis::Settled { refund }) if is_recipient => share.amount.checked_sub(*refund),
        (Portion::Food, Basis::Settled { refund }) if is_payer => Some(*refund),
        _ => Some(share.amount),
    };
    if expected.is_none_or(|amount| amount == 0 || amount != entry.amount) {
        return invalid("a collection takes exactly its part of the hold");
    }
    let hold_bid = bid_of(&hold.purpose);
    let ours = |bid: &Option<ActionHash>| hold_bid.is_some() && bid.as_ref() == hold_bid;
    let driver_pay = matches!(hold.purpose, HoldPurpose::DriverPay { .. });
    let store_fee = matches!(hold.purpose, HoldPurpose::Subsidy { .. });
    // A customer's refund resting on someone else's update -- a driver
    // leaving, calling the store late, the store ending it for want of a
    // driver -- can't also be theirs if they cancelled it themselves (owing
    // its driver) or chose to collect it (owing the food) on another branch.
    let customer_refund = |by_collecting: bool| -> ExternResult<bool> { Ok(is_payer && author == &hold.terms.requester && !customer_bound(author, prev_action, &hold.order, by_collecting)?) };
    let entitled = match (portion, basis) {
        // The food: split at its settlement; the customer's again if it never
        // arrived.
        (Portion::Food, Basis::Settled { .. }) => is_recipient || is_payer,
        (_, Basis::Settled { .. }) => false,
        (Portion::Food, Basis::Delivered { .. }) => false,
        (Portion::Food, Basis::NotDelivered { .. }) => is_payer,
        // The driver who delivered it is paid; their collateral, and what
        // the store set aside in case it kept them waiting, come back.
        (Portion::Collateral | Portion::LateCover, Basis::Delivered { bid }) => is_payer && ours(&bid),
        (Portion::Fee | Portion::Tip, Basis::Delivered { bid }) => is_recipient && ours(&bid),
        // Not delivered: the store takes the collateral for the food; the
        // driver's pay goes back.
        (Portion::Collateral, Basis::NotDelivered { bid }) => is_recipient && ours(&bid),
        (_, Basis::NotDelivered { bid }) => is_payer && ours(&bid),
        // A driver leaving before pickup: what the customer and the store set
        // aside for them goes back. Their collateral comes back once another
        // driver is confirmed -- or the store waives it, if they don't answer
        // for the food.
        // A driver who called the store late leaves paid in full by it, with
        // their collateral: they came for the food.
        (Portion::Fee | Portion::LateCover, Basis::Released { bid, store_late: true, .. }) if store_fee => is_recipient && hold_bid == Some(&bid),
        // A driver who left from the counter, checked in, has their
        // collateral back on leaving: the store's chain says they came, so
        // nothing can charge them for the food.
        (Portion::Collateral, Basis::Released { bid, at_store: true, .. }) => is_payer && hold_bid == Some(&bid),
        (Portion::Fee | Portion::Tip | Portion::LateCover, Basis::Released { bid, .. }) => is_payer && hold_bid == Some(&bid) && (!driver_pay || customer_refund(false)?),
        (Portion::Collateral, Basis::Replaced { bid }) => is_payer && hold_bid == Some(&bid),
        (_, Basis::Released { .. } | Basis::Replaced { .. }) => false,
        (portion, Basis::Cancelled(c)) => match c.by {
            // A customer who cancels once the store is cooking owes the food;
            // once a driver is assigned, their fee too.
            // A customer who cancels once they know the store is cooking
            // owes the food; once a driver is assigned, their fee too --
            // whichever version of the order they cancelled. What they knew
            // is on their own chain, in order: the version they cancelled,
            // their app's confirmation that it saw the store start, the
            // driver they took. Before any of that, cancelling costs nothing.
            Cancellation::ByCustomer => match portion {
                Portion::Food => is_recipient && ((c.cooking && c.from != Stage::Waiting && c.from != Stage::Other) || confirmed_cooking(&c, &hold.order, author, prev_action)?),
                Portion::Fee => is_recipient && driver_pay && ((matches!(c.from, Stage::DriverAssigned | Stage::AtStore) && ours(&c.bid)) || customer_took(&c, &hold.order, hold_bid, author, prev_action)?),
                _ => false,
            },
            // A store calling it off with the driver at its counter pays them
            // as if it had kept them waiting; and every driver's collateral is
            // theirs again -- the store ended it, on its own chain.
            Cancellation::ByStore(_) => match portion {
                Portion::Collateral => is_payer,
                _ => is_recipient && store_fee && c.from == Stage::AtStore && ours(&c.bid),
            },
            // A customer who chose to collect it and never came still owes
            // the food the store made.
            Cancellation::NotCollected => portion == Portion::Food && is_recipient,
            // The customer cancelling because the store kept a driver
            // waiting: they're refunded in full; a driver the store has
            // checked in is paid by the store, and every driver's collateral
            // is theirs again.
            Cancellation::StoreLate => match portion {
                Portion::Food => customer_refund(true)?,
                Portion::Fee | Portion::Tip if driver_pay => ours(&c.bid) && customer_refund(false)?,
                Portion::Fee | Portion::LateCover => is_recipient && store_fee && ours(&c.bid),
                Portion::Collateral => is_payer && ours(&c.bid),
                _ => false,
            },
            // No driver came: the customer is refunded, and the driver who
            // left it cooking pays the store for the food.
            Cancellation::NoDriver => match portion {
                Portion::Food => customer_refund(true)?,
                Portion::Collateral => is_recipient && c.liable.as_ref() == hold_bid,
                _ => false,
            },
            // The customer saying the store never answered -- after their
            // own app confirmed it had: the store is paid for the food.
            Cancellation::StoreDidNotRespond => portion == Portion::Food && is_recipient && confirmed_cooking(&c, &hold.order, author, prev_action)?,
        },
        // A part its recipient gave back.
        (_, Basis::Waived { by, hold: waived, portion: p }) => is_payer && by == share.recipient && &waived == hold_ref && p == portion,
    };
    require(entitled, "that isn't grounds for its author to collect this part of the hold")
}
