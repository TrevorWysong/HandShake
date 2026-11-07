//! How an order settles once it's out of the kitchen: the customer's
//! reports of missing or wrong items, the store's answers, and the store's
//! decisions -- the order's outcome, and its settlement of the food. The
//! model and its rules are `dispatch_types::issues` and
//! `dispatch_integrity`'s; this is the app side of them.
//!
//! The store's conductor makes its decisions on its own, as part of its
//! settlement sweep (`decide_order`): *delivered* as soon as the order is
//! completed on proof; *not delivered* once the customer's claim has stood
//! for a while with no delivery; the settlement once the customer's report
//! window has run, refunding what the store accepted or never answered.

use crate::order_queues::{classify, order_store, OrderEntry, QueueOwnerExt};
use crate::orders::{record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use dispatch_integrity::*;
use hdk::prelude::*;
use handshake_coordinator_support::{call_local, decode_or, guest, open_chunked, original_action_of, resolve_latest, seal_chunked, written};

// --- the order, as issues need it ---

/// An order's parties and its lines, each priced as ordered.
struct Priced {
    requester: AgentPubKey,
    merchant: AgentPubKey,
    order_total: u64,
    lines: Vec<crate::lines::LineView>,
}

impl Priced {
    /// Each line's (unit price, quantity), in order -- what
    /// `claimed_value` weighs.
    fn amounts(&self) -> Vec<(u64, u32)> {
        self.lines.iter().map(|line| (line.unit_price_cents, line.quantity)).collect()
    }
}

/// What reports on an order are judged against: its lines (reported by
/// position), and what the customer paid for the food.
#[derive(Serialize, Deserialize, Debug)]
pub struct IssueItems {
    pub order_total: u64,
    pub lines: Vec<crate::lines::LineView>,
}

/// An order's items as reports are made against them -- public, as the
/// order's lines are.
#[hdk_extern]
pub fn get_issue_items(order: ActionHash) -> ExternResult<IssueItems> {
    let terms = priced(&original_action_of(order)?)?;
    Ok(IssueItems { order_total: terms.order_total, lines: terms.lines })
}

fn priced(order: &ActionHash) -> ExternResult<Priced> {
    let record = get(order.clone(), GetOptions::default())?.ok_or(guest("order not found"))?;
    let (requester, merchant, order_total, lines) = match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => (o.requester, o.merchant, o.order_total, o.lines),
        (None, Some(o)) => (o.requester, o.merchant, o.order_total, o.lines),
        _ => return Err(guest("that isn't an order")),
    };
    Ok(Priced { requester, merchant, order_total, lines: crate::lines::describe(&lines)? })
}

// --- the customer ---

#[derive(Serialize, Deserialize, Debug)]
pub struct ReportIssueInput {
    pub order: ActionHash,
    pub lines: Vec<IssueLine>,
    pub note: String,
    /// An inline image, or empty for none.
    #[serde(default)]
    pub photo_data_uri: String,
    /// It had an allergen the store didn't say it had -- sealed with the note.
    #[serde(default)]
    pub allergen: bool,
}

/// The customer reporting items missing or wrong. Reported before the store
/// settles the order, it's refunded unless the store declines it.
#[hdk_extern]
pub fn report_issue(input: ReportIssueInput) -> ExternResult<Record> {
    let order = original_action_of(input.order)?;
    let terms = priced(&order)?;
    if terms.requester != agent_info()?.agent_initial_pubkey {
        return Err(guest("Only the order's customer can report a problem with it."));
    }
    if decisions_of(&order)?.settlement.is_some() {
        return Err(guest("The store has already settled this order."));
    }
    // Each line reported once -- validation's rule, told first.
    let reported: Vec<u32> = get_issues_for_order(order.clone())?.into_iter().flat_map(|view| view.lines.into_iter().map(|line| line.line)).collect();
    if input.lines.iter().any(|line| reported.contains(&line.line)) {
        return Err(guest("You've already reported a problem with one of these items."));
    }
    // The version showing they have it -- validation's rule, told first.
    let latest = resolve_latest(order.clone())?;
    let received = match (decode_or::<DeliveryOrder>(&latest), decode_or::<PickupOrder>(&latest)) {
        (Some(delivery), _) => delivery.status == DeliveryStatus::Delivered,
        (None, Some(pickup)) => pickup.status == PickupStatus::PickedUp,
        _ => false,
    };
    if !received {
        return Err(guest("You can report a problem once you have your order."));
    }
    crate::orders::check_note(&input.note)?;
    if let Some(problem) = handshake_integrity_support::image_problem(&input.photo_data_uri) {
        return Err(guest(problem));
    }
    let evidence = IssueEvidence { note: input.note, photo_data_uri: input.photo_data_uri, allergen: input.allergen };
    let issue = ItemIssue {
        order: order.clone(),
        received: latest.action_address().clone(),
        lines: input.lines,
        sealed_for_store: seal_chunked(&terms.merchant, &evidence)?,
    };
    let hash = create_entry(&EntryTypes::ItemIssue(issue))?;
    create_link(order.clone(), hash.clone(), LinkTypes::OrderToIssue, ())?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::IssueReported { order_hash: order }, vec![terms.merchant]);
    written(hash)
}

// --- the store ---

#[derive(Serialize, Deserialize, Debug)]
pub struct RespondToIssueInput {
    pub issue: ActionHash,
    pub accept: bool,
}

/// The store accepting an issue (the customer is refunded when it settles)
/// or declining it (they aren't). The store has the final say. Once per
/// issue.
#[hdk_extern]
pub fn respond_to_issue(input: RespondToIssueInput) -> ExternResult<Record> {
    let record = get(input.issue.clone(), GetOptions::default())?.ok_or(guest("report not found"))?;
    let issue = decode_or::<ItemIssue>(&record).ok_or(guest("that isn't a report"))?;
    if decisions_of(&issue.order)?.settlement.is_some() {
        return Err(guest("This order is already settled."));
    }
    let hash = create_entry(&EntryTypes::IssueResponse(IssueResponse { issue: input.issue.clone(), accept: input.accept }))?;
    create_link(input.issue, hash.clone(), LinkTypes::IssueToResponse, ())?;
    written(hash)
}

// --- reading ---

/// One report, as its order's parties see it.
#[derive(Serialize, Deserialize, Debug)]
pub struct IssueView {
    pub issue: ActionHash,
    pub reported_at: Timestamp,
    pub lines: Vec<IssueLine>,
    /// What it's worth of what the customer paid.
    pub value: u64,
    /// The store's answer: accepted, declined, or not yet.
    pub accepted: Option<bool>,
    /// The note and photo, for the customer and the store.
    pub evidence: Option<IssueEvidence>,
}

/// Every report on an order, with the store's answer and its worth.
#[hdk_extern]
pub fn get_issues_for_order(order: ActionHash) -> ExternResult<Vec<IssueView>> {
    let order = original_action_of(order)?;
    let terms = priced(&order)?;
    let me = agent_info()?.agent_initial_pubkey;
    let now = sys_time()?;
    let mut views = Vec::new();
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToIssue)?, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        let Some(issue) = decode_or::<ItemIssue>(&record).filter(|i| i.order == order && record.action().author() == &terms.requester) else { continue };
        // A report dated ahead of this clock isn't reported yet: counting it
        // would let a customer hold a settlement back, or have one cite a
        // report the store can't answer yet (validation refuses that).
        if record.action().timestamp() > now {
            continue;
        }
        let claimed: Vec<(u32, u32)> = issue.lines.iter().map(|l| (l.line, l.quantity)).collect();
        let evidence: Option<IssueEvidence> = if me == terms.requester {
            open_chunked(&terms.merchant, &issue.sealed_for_store)?
        } else if me == terms.merchant {
            open_chunked(&terms.requester, &issue.sealed_for_store)?
        } else {
            None
        };
        views.push(IssueView {
            issue: hash.clone(),
            reported_at: record.action().timestamp(),
            value: claimed_value(&terms.amounts(), terms.order_total, &claimed),
            accepted: store_answer(&hash, &terms.merchant)?,
            evidence: evidence.filter(|e| handshake_integrity_support::image_problem(&e.photo_data_uri).is_none()),
            lines: issue.lines,
        });
    }
    views.sort_by_key(|v| v.reported_at);
    Ok(views)
}

/// The store's answer to an issue, if it's given one.
fn store_answer(issue: &ActionHash, merchant: &AgentPubKey) -> ExternResult<Option<bool>> {
    for link in get_links(LinkQuery::try_new(issue.clone(), LinkTypes::IssueToResponse)?.author(merchant.clone()), GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Some(response) = get(hash, GetOptions::default())?.and_then(|r| decode_or::<IssueResponse>(&r)) {
            return Ok(Some(response.accept));
        }
    }
    Ok(None)
}

/// How far back a store's unanswered reports are looked for: a report can only
/// come once a customer has their order, and one can be scheduled five days
/// ahead of that.
const REPORTS_SCAN_DAYS: i64 = 6;
/// The most orders one read checks, newest first, so a busy store's costs the
/// same however long its week.
const REPORTS_SCAN_ORDERS: usize = 250;

/// The store's orders with a report it hasn't answered and hasn't settled:
/// what its Issues tab lists. Reads only what's already public on each order.
#[hdk_extern]
pub fn get_orders_awaiting_answer(catalog_ref: ActionHash) -> ExternResult<Vec<OrderEntry>> {
    let store = QueueOwner::Store(&catalog_ref);
    let today = history_day(sys_time()?);
    let mut orders = Vec::new();
    for day in ((today - REPORTS_SCAN_DAYS)..=today).rev() {
        orders.extend(store.orders_on_day(day)?);
        if orders.len() >= REPORTS_SCAN_ORDERS {
            break;
        }
    }
    orders.truncate(REPORTS_SCAN_ORDERS);
    orders.sort();
    orders.dedup();
    // One order failing (still gossiping, say) mustn't hide the rest; the next
    // read tries it again.
    Ok(orders.into_iter().filter_map(|order| awaiting_answer(&catalog_ref, order).ok().flatten()).collect())
}

fn awaiting_answer(catalog_ref: &ActionHash, order: ActionHash) -> ExternResult<Option<OrderEntry>> {
    // Most orders have no reports: this one read rules them out.
    if get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToIssue)?, GetStrategy::default())?.is_empty() {
        return Ok(None);
    }
    let Some((entry, _, _)) = classify(order.clone()) else { return Ok(None) };
    if order_store(entry.kind, &entry.record).as_ref() != Some(catalog_ref) || decisions_of(&order)?.settlement.is_some() {
        return Ok(None);
    }
    Ok(get_issues_for_order(order)?.iter().any(|issue| issue.accepted.is_none()).then_some(entry))
}

// --- the store's decisions ---

/// The store's decisions about an order, as its links record them.
#[derive(Debug, Default)]
pub(crate) struct Decisions {
    /// Its outcome: delivered -- and the bid that delivered it.
    pub delivered: Option<(ActionHash, Option<ActionHash>)>,
    /// Its outcome: never delivered -- and the bid that had it.
    pub not_delivered: Option<(ActionHash, Option<ActionHash>)>,
    /// Its settlement of the food, and the refund it names.
    pub settlement: Option<(ActionHash, u64)>,
}

/// The store's decisions about `order` (its original action) -- only ever
/// the store's own: anyone else's link is ignored.
pub(crate) fn decisions_of(order: &ActionHash) -> ExternResult<Decisions> {
    let (_, merchant) = parties_of(order)?;
    let mut decisions = Decisions::default();
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToDecision)?.author(merchant.clone()), GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        if let Some(outcome) = decode_or::<OrderOutcome>(&record).filter(|o| &o.order == order) {
            let bid_at = |version: &ActionHash| get(version.clone(), GetOptions::default()).ok().flatten().and_then(|r| decode_or::<DeliveryOrder>(&r)).and_then(|o| o.accepted_bid);
            match outcome.outcome {
                Outcome::Delivered { proof } => decisions.delivered = Some((hash, bid_at(&proof))),
                Outcome::NotDelivered { claim } => decisions.not_delivered = Some((hash, bid_at(&claim))),
            }
        } else if let Some(settlement) = decode_or::<ItemSettlement>(&record).filter(|s| &s.order == order) {
            decisions.settlement = Some((hash, settlement.refund));
        }
    }
    Ok(decisions)
}

/// An order's customer and store.
pub(crate) fn parties_of(order: &ActionHash) -> ExternResult<(AgentPubKey, AgentPubKey)> {
    let record = get(order.clone(), GetOptions::default())?.ok_or(guest("order not found"))?;
    match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => Ok((o.requester, o.merchant)),
        (None, Some(o)) => Ok((o.requester, o.merchant)),
        _ => Err(guest("that isn't an order")),
    }
}

/// How an order stands with its store, for its screens.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct OrderDecisions {
    /// The store decided it was delivered.
    pub delivered: bool,
    /// The store decided it never was: the customer is refunded.
    pub not_delivered: bool,
    /// The store has settled the food: the refund it named.
    pub refund: Option<u64>,
    /// When the customer's report window ends, once they have the order --
    /// when the store's app settles it.
    pub reports_until: Option<Timestamp>,
    /// When the store's app decides an unanswered claim that it never
    /// arrived -- refunding the customer -- if there is one.
    pub claim_decided_after: Option<Timestamp>,
    /// When the store's app upholds its driver's word that nobody came to
    /// take the order -- paid as delivered -- if the order rests on it:
    /// disputed or not, unless the store sides with the customer first.
    pub no_show_upheld_after: Option<Timestamp>,
    /// A pickup the customer said they couldn't get, and the store answered is
    /// ready: they can't report that again.
    pub report_dismissed: bool,
}

/// The store's settlement of `order` (any version), if it's settled --
/// what its customer earns rewards points on (the rewards zome).
#[hdk_extern]
pub fn order_settlement(order: ActionHash) -> ExternResult<Option<ActionHash>> {
    Ok(decisions_of(&original_action_of(order)?)?.settlement.map(|(settlement, _)| settlement))
}

/// How `order` stands with its store.
#[hdk_extern]
pub fn get_order_decisions(order: ActionHash) -> ExternResult<OrderDecisions> {
    let order = original_action_of(order)?;
    let decisions = decisions_of(&order)?;
    let latest = resolve_latest(order.clone())?;
    let at = latest.action().timestamp().as_micros();
    let (has_it, claimed) = match (decode_or::<DeliveryOrder>(&latest), decode_or::<PickupOrder>(&latest)) {
        (Some(o), _) => (matches!(o.status, DeliveryStatus::Delivered | DeliveryStatus::Collected), o.status == DeliveryStatus::Disputed),
        (None, Some(o)) => (o.status == PickupStatus::PickedUp, false),
        _ => (false, false),
    };
    let undecided = decisions.delivered.is_none() && decisions.not_delivered.is_none();
    let no_show = no_show_word(&latest)?.filter(|_| undecided);
    let window = handshake_governance::report_window().as_micros() as i64;
    Ok(OrderDecisions {
        delivered: decisions.delivered.is_some(),
        not_delivered: decisions.not_delivered.is_some(),
        refund: decisions.settlement.map(|(_, refund)| refund),
        reports_until: has_it.then(|| Timestamp::from_micros(at + window)),
        claim_decided_after: (claimed && no_show.is_none() && decisions.not_delivered.is_none()).then(|| Timestamp::from_micros(at + claim_grace_micros())),
        no_show_upheld_after: no_show.map(|word| Timestamp::from_micros(word.action().timestamp().as_micros() + window)),
        report_dismissed: report_dismissed(&latest)?,
    })
}

/// Whether a pickup's version is the store's answer to a customer who said they
/// couldn't get it: the only way a ready order follows a disputed one.
pub(crate) fn report_dismissed(version: &Record) -> ExternResult<bool> {
    let ready = decode_or::<PickupOrder>(version).is_some_and(|o| o.status == PickupStatus::ReadyForPickup);
    let ActionData::Update(update) = &version.action().data else { return Ok(false) };
    if !ready {
        return Ok(false);
    }
    Ok(get(update.original_action_address.clone(), GetOptions::default())?.and_then(|r| decode_or::<PickupOrder>(&r)).is_some_and(|prior| prior.status == PickupStatus::Disputed))
}

/// `handshake_governance::claim_grace`, in microseconds. The store can decide
/// sooner (`decide_not_delivered`).
fn claim_grace_micros() -> i64 {
    handshake_governance::claim_grace().as_micros() as i64
}

/// `handshake_governance::answer_grace`, in microseconds.
fn answer_grace_micros() -> i64 {
    handshake_governance::answer_grace().as_micros() as i64
}

/// The refund the store's answers add up to: every report it accepted or
/// never answered. The store has the final say -- one it declined isn't
/// refunded -- as it would if you ordered from it directly.
fn refund_owed(terms: &Priced, issues: &[IssueView]) -> (Vec<ActionHash>, u64) {
    let refunded: Vec<&IssueView> = issues.iter().filter(|i| i.accepted != Some(false)).collect();
    let claimed: Vec<(u32, u32)> = refunded.iter().flat_map(|i| i.lines.iter().map(|l| (l.line, l.quantity))).collect();
    (refunded.iter().map(|i| i.issue.clone()).collect(), claimed_value(&terms.amounts(), terms.order_total, &claimed))
}

/// Has the store's conductor make its decisions on `order`, in a call of its
/// own -- a decision that doesn't validate yet must never undo the
/// caller's. Does nothing unless the caller is the order's store. Whether
/// it decided anything.
pub(crate) fn decide_as_store(order: &ActionHash) -> bool {
    let is_store = parties_of(order).ok().zip(agent_info().ok()).is_some_and(|((_, merchant), me)| merchant == me.agent_initial_pubkey);
    let Ok(zome) = zome_info().map(|z| z.name) else { return false };
    if !is_store {
        return false;
    }
    match call(CallTargetCell::Local, zome, "decide_order".into(), None, order.clone()) {
        Ok(ZomeCallResponse::Ok(io)) => io.decode::<bool>().unwrap_or(false),
        _ => false,
    }
}

/// A store decision, to write.
#[derive(Serialize, Deserialize, Debug)]
pub enum DecisionWire {
    Outcome(OrderOutcome),
    Settlement(ItemSettlement),
}

/// Writes one of the caller's decisions, linked under its order -- in a zome
/// call of its own (`record_decision`), so it's committed before anything
/// that cites it is written.
#[hdk_extern]
pub fn write_decision(decision: DecisionWire) -> ExternResult<ActionHash> {
    let (order, entry) = match decision {
        DecisionWire::Outcome(outcome) => (outcome.order.clone(), EntryTypes::OrderOutcome(outcome)),
        DecisionWire::Settlement(settlement) => (settlement.order.clone(), EntryTypes::ItemSettlement(settlement)),
    };
    let hash = create_entry(&entry)?;
    create_link(order, hash.clone(), LinkTypes::OrderToDecision, ())?;
    Ok(hash)
}

fn record_decision(decision: DecisionWire) -> ExternResult<ActionHash> {
    call_local(zome_info()?.name, "write_decision", decision)?.map_err(|why| guest(format!("couldn't record the decision: {why}")))
}

/// The caller (an order's store) making whatever decisions on it are due:
/// its outcome, then its settlement. Returns whether it decided anything.
#[hdk_extern]
pub fn decide_order(order: ActionHash) -> ExternResult<bool> {
    let order = original_action_of(order)?;
    let me = agent_info()?.agent_initial_pubkey;
    let (requester, merchant) = parties_of(&order)?;
    if me != merchant {
        return Ok(false);
    }
    let now = sys_time()?.as_micros();
    let mut decisions = decisions_of(&order)?;
    let latest = resolve_latest(order.clone())?;

    // When the customer had the order, if they do: the basis a settlement
    // cites, and when its report window started.
    let has_it = match (decode_or::<DeliveryOrder>(&latest), decode_or::<PickupOrder>(&latest)) {
        (Some(delivery), _) => {
            if decisions.delivered.is_none() && decisions.not_delivered.is_none() {
                let no_show = no_show_word(&latest)?;
                match (&delivery.status, no_show) {
                    (DeliveryStatus::Delivered, _) => {
                        let hash = record_decision(DecisionWire::Outcome(OrderOutcome { order: order.clone(), outcome: Outcome::Delivered { proof: latest.action_address().clone() } }))?;
                        // A customer who claimed it never came, and it had.
                        if came_out_of_claim(&latest)? {
                            record_reputation_event(&requester, ReputationTargetWire::Customer(requester.clone()), order.clone(), ReputationEventKindWire::DisputeResolvedAgainst, hash.clone())?;
                        }
                        delivered_on(&order, &delivery, &hash)?;
                        decisions.delivered = Some((hash, delivery.accepted_bid.clone()));
                    }
                    // The driver's word that nobody came -- disputed or not --
                    // upheld once the customer's report window from it has
                    // run: a store siding with the customer decides it never
                    // arrived before then (`decide_not_delivered`).
                    (_, Some(word)) => {
                        if now >= word.action().timestamp().as_micros() + handshake_governance::report_window().as_micros() as i64 {
                            let hash = record_decision(DecisionWire::Outcome(OrderOutcome { order: order.clone(), outcome: Outcome::Delivered { proof: word.action_address().clone() } }))?;
                            record_reputation_event(&requester, ReputationTargetWire::Customer(requester.clone()), order.clone(), ReputationEventKindWire::NoShow, hash.clone())?;
                            delivered_on(&order, &delivery, &hash)?;
                            let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: order.clone() }, vec![requester.clone()]);
                            return Ok(true);
                        }
                    }
                    (DeliveryStatus::Disputed, None) if now >= latest.action().timestamp().as_micros() + claim_grace_micros() => {
                        not_delivered(&order, &latest, &delivery)?;
                        return Ok(true);
                    }
                    _ => {}
                }
            }
            if delivery.status == DeliveryStatus::Collected {
                // Collected from the store: no driver, so nothing to decide
                // but the food -- settled on the collection, as a pickup is.
                Some((latest.action_address().clone(), latest.action().timestamp()))
            } else {
                decisions.delivered.clone().map(|(outcome, _)| (outcome, latest.action().timestamp()))
            }
        }
        (None, Some(pickup)) => {
            // A customer who says they can't get it, unanswered: the store's
            // answer is that it's ready. Nobody's charged by that alone: only
            // by the store recording it uncollected, past their new window.
            if pickup.status == PickupStatus::Disputed && now >= latest.action().timestamp().as_micros() + answer_grace_micros() {
                crate::pickup::dismiss_pickup_problem(order)?;
                return Ok(true);
            }
            (pickup.status == PickupStatus::PickedUp && latest.action().author() == &requester).then(|| (latest.action_address().clone(), latest.action().timestamp()))
        }
        _ => None,
    };

    // The settlement, once the customer's report window has run and every
    // report has had its grace.
    let Some((basis, since)) = has_it else { return Ok(false) };
    if decisions.settlement.is_some() || now < since.as_micros() + handshake_governance::report_window().as_micros() as i64 {
        return Ok(false);
    }
    let terms = priced(&order)?;
    // Nothing to settle for food nobody paid for (an order from the
    // customer's own store).
    if requester == merchant {
        return Ok(false);
    }
    let issues = get_issues_for_order(order.clone())?;
    if issues.iter().any(|i| i.accepted.is_none() && now < i.reported_at.as_micros() + answer_grace_micros()) {
        return Ok(false);
    }
    let (cited, issues_refund) = refund_owed(&terms, &issues);
    // A customer who collected their delivery themselves is refunded the
    // store's share of the fee it would have paid a driver, too.
    let collected_owed = match get(basis.clone(), GetOptions::default())?.and_then(dispatch_integrity::lineage::Version::of) {
        Some(version) if version.order.status == DeliveryStatus::Collected => dispatch_integrity::lineage::collection_owed(&version)?,
        _ => 0,
    };
    let refund = issues_refund.saturating_add(collected_owed).min(terms.order_total);
    record_decision(DecisionWire::Settlement(ItemSettlement { order: order.clone(), basis, issues: cited, refund }))?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: order }, vec![requester]);
    Ok(true)
}

/// The driver's word that nobody came to take the order, if `latest` rests
/// on it: that version itself, or the one the customer's dispute of it
/// replaced.
fn no_show_word(latest: &Record) -> ExternResult<Option<Record>> {
    let status = |record: &Record| decode_or::<DeliveryOrder>(record).map(|o| o.status);
    match status(latest) {
        Some(DeliveryStatus::Unanswered) => Ok(Some(latest.clone())),
        Some(DeliveryStatus::Disputed) => {
            let ActionData::Update(update) = &latest.action().data else { return Ok(None) };
            let prior = get(update.original_action_address.clone(), GetOptions::default())?;
            Ok(prior.filter(|p| status(p) == Some(DeliveryStatus::Unanswered)))
        }
        _ => Ok(None),
    }
}

/// The store's decision that the order was delivered (`outcome`), as it
/// reaches the driver: their completed delivery, and the pay they collect
/// on it. Finished: off every queue, the driver's included.
fn delivered_on(order: &ActionHash, delivery: &DeliveryOrder, outcome: &ActionHash) -> ExternResult<()> {
    if let Some(bid) = delivery.accepted_bid.as_ref().and_then(|b| get(b.clone(), GetOptions::default()).ok().flatten()).and_then(|r| decode_or::<Bid>(&r)) {
        record_reputation_event(&bid.bidder, ReputationTargetWire::Driver(bid.bidder.clone()), order.clone(), ReputationEventKindWire::OrderCompleted, outcome.clone())?;
        let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: order.clone() }, vec![bid.bidder]);
    }
    crate::order_queues::retire(&crate::OrderParties::delivery(order, delivery)?)
}

/// Whether a delivered version came out of the customer's claim that it
/// never arrived.
fn came_out_of_claim(delivered: &Record) -> ExternResult<bool> {
    let ActionData::Update(update) = &delivered.action().data else { return Ok(false) };
    Ok(get(update.original_action_address.clone(), GetOptions::default())?.and_then(|r| decode_or::<DeliveryOrder>(&r)).is_some_and(|prior| prior.status == DeliveryStatus::Disputed))
}

/// The store deciding the order never arrived, on the customer's claim
/// (`claim`): everyone's money goes back, and the driver's collateral pays
/// the store for the food -- recorded against the driver.
fn not_delivered(order: &ActionHash, claim: &Record, delivery: &DeliveryOrder) -> ExternResult<ActionHash> {
    let hash = record_decision(DecisionWire::Outcome(OrderOutcome { order: order.clone(), outcome: Outcome::NotDelivered { claim: claim.action_address().clone() } }))?;
    if let Some(bid_ref) = &delivery.accepted_bid {
        if let Some(bid) = get(bid_ref.clone(), GetOptions::default())?.and_then(|r| decode_or::<Bid>(&r)) {
            let driver = bid.bidder;
            record_reputation_event(&driver, ReputationTargetWire::Driver(driver.clone()), order.clone(), ReputationEventKindWire::DisputeResolvedAgainst, hash.clone())?;
            record_reputation_event(&driver, ReputationTargetWire::Driver(driver.clone()), order.clone(), ReputationEventKindWire::CollateralForfeited { amount: bid.collateral }, hash.clone())?;
            let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: order.clone() }, vec![delivery.requester.clone(), driver]);
        }
    }
    // Finished: off every queue, the driver's included.
    crate::order_queues::retire(&crate::OrderParties::delivery(order, delivery)?)?;
    Ok(hash)
}

/// The store deciding, now, that a claimed order never arrived -- rather
/// than waiting out the claim's grace.
#[hdk_extern]
pub fn decide_not_delivered(order: ActionHash) -> ExternResult<ActionHash> {
    let order = original_action_of(order)?;
    let (_, merchant) = parties_of(&order)?;
    if merchant != agent_info()?.agent_initial_pubkey {
        return Err(guest("Only the order's store decides this."));
    }
    let decisions = decisions_of(&order)?;
    if decisions.delivered.is_some() || decisions.not_delivered.is_some() {
        return Err(guest("This order's outcome is already decided."));
    }
    let latest = resolve_latest(order.clone())?;
    let delivery = decode_or::<DeliveryOrder>(&latest).filter(|o| o.status == DeliveryStatus::Disputed).ok_or(guest("The customer hasn't said it never arrived."))?;
    not_delivered(&order, &latest, &delivery)
}
