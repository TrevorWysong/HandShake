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

use crate::order_queues::{classify, order_store, OrderEntry};
use crate::orders::{record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use dispatch_integrity::*;
use hdk::prelude::*;
use handshake_coordinator_support::{arrived, call_local, decode_or, guest, open_chunked, original_action_of, resolve_latest, seal_chunked, written};

// --- the order, as issues need it ---

/// An order's parties and its lines, each priced as ordered.
struct Priced {
    requester: AgentPubKey,
    merchant: AgentPubKey,
    catalog_ref: ActionHash,
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
/// position), and what the customer paid for the food -- and whose order it
/// is, at which store, for points its store gives with an answer.
#[derive(Serialize, Deserialize, Debug)]
pub struct IssueItems {
    pub order_total: u64,
    pub lines: Vec<crate::lines::LineView>,
    pub customer: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// What a report on the delivery itself would be worth -- the
    /// customer's share of the fee for the driver who brought it -- or
    /// `None` where there's none to make: a pickup, one they collected, or
    /// a fee the store paid all of.
    pub delivery_report_worth: Option<u64>,
    /// The driver who delivered it, if one did -- whom a store may find at
    /// fault for a poor delivery (docs/REPUTATION.md, phase 3).
    pub driver: Option<AgentPubKey>,
}

/// An order's items as reports are made against them -- public, as the
/// order's lines are.
#[hdk_extern]
pub fn get_issue_items(order: ActionHash) -> ExternResult<IssueItems> {
    let order = original_action_of(order)?;
    let terms = priced(&order)?;
    let delivered = delivered_by(resolve_latest(order)?.action_address())?;
    let delivery_report_worth = delivered.as_ref().map(|(bid, store_percent)| service_value(bid.price_offer, *store_percent)).filter(|worth| *worth > 0);
    let driver = delivered.map(|(bid, _)| bid.bidder);
    Ok(IssueItems { order_total: terms.order_total, lines: terms.lines, customer: terms.requester, catalog_ref: terms.catalog_ref, delivery_report_worth, driver })
}

fn priced(order: &ActionHash) -> ExternResult<Priced> {
    let record = get(order.clone(), GetOptions::default())?.ok_or(guest("order not found"))?;
    let (requester, merchant, catalog_ref, order_total, lines) = match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => (o.requester, o.merchant, o.catalog_ref, o.order_total, o.lines),
        (None, Some(o)) => (o.requester, o.merchant, o.catalog_ref, o.order_total, o.lines),
        _ => return Err(guest("that isn't an order")),
    };
    Ok(Priced { requester, merchant, catalog_ref, order_total, lines: crate::lines::describe(&lines)? })
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
    /// The delivery itself was poor, not an item: no lines, worth the
    /// customer's share of its fee (`ItemIssue::service`).
    #[serde(default)]
    pub service: bool,
}

/// The customer reporting items missing or wrong, or that the delivery
/// itself was poor. Reported before the store settles the order, it's
/// refunded unless the store declines it.
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
    // Each line, and the delivery, reported once -- validation's rules,
    // told first.
    let views = get_issues_for_order(order.clone())?;
    if input.service && (!input.lines.is_empty() || views.iter().any(|view| view.service)) {
        return Err(guest("You've already told the store about the delivery."));
    }
    let reported: Vec<u32> = views.into_iter().flat_map(|view| view.lines.into_iter().map(|line| line.line)).collect();
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
    // About the delivery: worth the customer's share of its fee, and sealed
    // to its driver too, who may be asked to answer for it.
    let driver = match input.service {
        true => match delivered_by(latest.action_address())? {
            Some((bid, store_percent)) if service_value(bid.price_offer, store_percent) > 0 => Some(bid.bidder),
            _ => return Err(guest("You can tell the store about a delivery a driver brought you, if you paid toward its fee.")),
        },
        false => None,
    };
    let issue = ItemIssue {
        order: order.clone(),
        received: latest.action_address().clone(),
        lines: input.lines,
        sealed_for_store: seal_chunked(&terms.merchant, &evidence)?,
        service: input.service,
        sealed_for_driver: driver.map(|driver| seal_chunked(&driver, &evidence)).transpose()?,
    };
    let hash = create_entry(&EntryTypes::ItemIssue(issue))?;
    create_link(order.clone(), hash.clone(), LinkTypes::OrderToIssue, ())?;
    // On the store's list of reports to answer, tagged with the order.
    let catalog_ref = decode_or::<DeliveryOrder>(&latest).map(|o| o.catalog_ref).or_else(|| decode_or::<PickupOrder>(&latest).map(|o| o.catalog_ref)).ok_or(guest("order not found"))?;
    create_link(catalog_ref, hash.clone(), LinkTypes::StoreToReport, LinkTag::new(order.get_raw_39().to_vec()))?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::IssueReported { order_hash: order }, vec![terms.merchant]);
    written(hash)
}

// --- the store ---

#[derive(Serialize, Deserialize, Debug)]
pub struct RespondToIssueInput {
    pub issue: ActionHash,
    pub accept: bool,
    /// Accepting it for part of what it's worth: this much. `None`, or all
    /// it's worth or more, for all of it.
    #[serde(default)]
    pub refund: Option<u64>,
}

/// The store accepting an issue (the customer is refunded, all it's worth
/// or the part the store names, when it settles) or declining it (they
/// aren't). The store has the final say. Once per issue.
#[hdk_extern]
pub fn respond_to_issue(input: RespondToIssueInput) -> ExternResult<Record> {
    let record = arrived(&input.issue)?;
    let issue = decode_or::<ItemIssue>(&record).ok_or(guest("that isn't a report"))?;
    if decisions_of(&issue.order)?.settlement.is_some() {
        return Err(guest("This order is already settled."));
    }
    let refund = match (input.accept, input.refund) {
        (false, Some(_)) => return Err(guest("A declined report refunds nothing.")),
        (true, Some(0)) => return Err(guest("To refund nothing, decline the report.")),
        (true, Some(part)) => (part < value_of(&issue)?).then_some(part),
        (_, None) => None,
    };
    let hash = create_entry(&EntryTypes::IssueResponse(IssueResponse { issue: input.issue.clone(), accept: input.accept, refund }))?;
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
    /// What the store's answer refunds: all it's worth or the part it
    /// named, nothing for a decline -- `None` before it answers.
    pub refund: Option<u64>,
    /// The store's answer itself, once it's given -- what a finding on the
    /// report cites (docs/REPUTATION.md).
    pub answer: Option<ActionHash>,
    /// The note and photo, for the customer and the store.
    pub evidence: Option<IssueEvidence>,
    /// That it's about the delivery itself, not items: worth the customer's
    /// share of its fee.
    pub service: bool,
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
        let record = arrived(&hash)?;
        let Some(issue) = decode_or::<ItemIssue>(&record).filter(|i| i.order == order && record.action().author() == &terms.requester) else { continue };
        // A report dated ahead of this clock isn't reported yet: counting it
        // would let a customer hold a settlement back, or have one cite a
        // report the store can't answer yet (validation refuses that).
        if record.action().timestamp() > now {
            continue;
        }
        let value = value_in(&issue, &terms)?;
        let answer = store_answer(&hash, &terms.merchant)?;
        let evidence: Option<IssueEvidence> = if me == terms.requester {
            open_chunked(&terms.merchant, &issue.sealed_for_store)?
        } else if me == terms.merchant {
            open_chunked(&terms.requester, &issue.sealed_for_store)?
        } else if let Some(sealed) = &issue.sealed_for_driver {
            // The driver who brought it, for a report on the delivery: only
            // theirs opens.
            open_chunked(&terms.requester, sealed)?
        } else {
            None
        };
        views.push(IssueView {
            issue: hash.clone(),
            reported_at: record.action().timestamp(),
            value,
            accepted: answer.as_ref().map(|(_, a)| a.accept),
            refund: answer.as_ref().map(|(_, a)| a.refunds(value)),
            answer: answer.as_ref().map(|(hash, _)| hash.clone()),
            evidence: evidence.filter(|e| handshake_integrity_support::image_problem(&e.photo_data_uri).is_none()),
            service: issue.service,
            lines: issue.lines,
        });
    }
    views.sort_by_key(|v| v.reported_at);
    Ok(views)
}

/// What an issue claims is worth, of what its order's customer paid.
fn value_of(issue: &ItemIssue) -> ExternResult<u64> {
    value_in(issue, &priced(&issue.order)?)
}

/// `value_of`, with the order already read: its items' share of what was
/// paid, or for the delivery itself, the customer's share of its fee --
/// validation's reckoning (`integrity/src/issues.rs`).
fn value_in(issue: &ItemIssue, terms: &Priced) -> ExternResult<u64> {
    if issue.service {
        return Ok(service_worth(&issue.received)?.unwrap_or(0));
    }
    let claimed: Vec<(u32, u32)> = issue.lines.iter().map(|l| (l.line, l.quantity)).collect();
    Ok(claimed_value(&terms.amounts(), terms.order_total, &claimed))
}

/// What a report on a delivery's service is worth, citing `received` -- the
/// customer's share of the fee for the driver who delivered it -- or `None`
/// if it can't be one. Validated with the report: one not here yet is an
/// error.
fn service_worth(received: &ActionHash) -> ExternResult<Option<u64>> {
    Ok(delivered_by(received)?.map(|(bid, store_percent)| service_value(bid.price_offer, store_percent)))
}

/// The bid that delivered an order, by its `received` version -- with the
/// store's share of its fee -- or `None` if no driver delivered it.
fn delivered_by(received: &ActionHash) -> ExternResult<Option<(Bid, u8)>> {
    let Some(version) = decode_or::<DeliveryOrder>(&arrived(received)?) else { return Ok(None) };
    let Some(bid) = version.accepted_bid.filter(|_| version.status == DeliveryStatus::Delivered) else { return Ok(None) };
    Ok(decode_or::<Bid>(&arrived(&bid)?).map(|bid| (bid, version.delivery_subsidy_percent)))
}

/// The store's answer to an issue, if it's given one.
fn store_answer(issue: &ActionHash, merchant: &AgentPubKey) -> ExternResult<Option<(ActionHash, IssueResponse)>> {
    for link in get_links(LinkQuery::try_new(issue.clone(), LinkTypes::IssueToResponse)?.author(merchant.clone()), GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        // Validated, by the store: one not here yet is an error, never an
        // issue left unanswered.
        if let Some(response) = decode_or::<IssueResponse>(&arrived(&hash)?) {
            return Ok(Some((hash, response)));
        }
    }
    Ok(None)
}

/// The store's orders with a report it hasn't answered and hasn't settled:
/// what its Issues tab lists. Read from the store's list of reports (each
/// filed there by its customer, tagged with its order), however busy the
/// store and however old the report -- and each one answered or settled
/// since is cleared from the list as it's found.
#[hdk_extern]
pub fn get_orders_awaiting_answer(catalog_ref: ActionHash) -> ExternResult<Vec<OrderEntry>> {
    let links = get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::StoreToReport)?, GetStrategy::default())?;
    let mut orders: Vec<(ActionHash, Vec<ActionHash>)> = Vec::new();
    for link in links {
        let Ok(order) = ActionHash::try_from_raw_39(link.tag.0.clone()) else { continue };
        match orders.iter_mut().find(|(o, _)| o == &order) {
            Some((_, of)) => of.push(link.create_link_hash),
            None => orders.push((order, vec![link.create_link_hash])),
        }
    }
    let mut waiting = Vec::new();
    let mut answered = Vec::new();
    for (order, of) in orders {
        // One order failing (still gossiping, say) mustn't hide the rest;
        // the next read tries it again.
        match awaiting_answer(&catalog_ref, order) {
            Ok(Some(entry)) => waiting.push(entry),
            Ok(None) => answered.extend(of),
            Err(_) => {}
        }
    }
    // Answered or settled: off the list, in a call of its own -- and only
    // by the store, which validation holds it to.
    if !answered.is_empty() {
        let _ = handshake_coordinator_support::isolated::<_, ()>("clear_answered_reports", answered);
    }
    Ok(waiting)
}

/// Clears reports the caller's store has answered or settled from its list.
#[hdk_extern]
pub fn clear_answered_reports(links: Vec<ActionHash>) -> ExternResult<()> {
    for link in links {
        delete_link(link, GetOptions::default())?;
    }
    Ok(())
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
        // Validated, and what each rests on with it: one not here yet would
        // read as a decision never made, so it's an error instead.
        let record = arrived(&hash)?;
        if let Some(outcome) = decode_or::<OrderOutcome>(&record).filter(|o| &o.order == order) {
            let bid_at = |version: &ActionHash| arrived(version).map(|r| decode_or::<DeliveryOrder>(&r).and_then(|o| o.accepted_bid));
            match outcome.outcome {
                Outcome::Delivered { proof } => decisions.delivered = Some((hash, bid_at(&proof)?)),
                Outcome::NotDelivered { claim } => decisions.not_delivered = Some((hash, bid_at(&claim)?)),
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
    parties_in(&record).ok_or(guest("that isn't an order"))
}

/// An order record's customer and store; `None` for a record that isn't an
/// order.
pub(crate) fn parties_in(record: &Record) -> Option<(AgentPubKey, AgentPubKey)> {
    match (decode_or::<DeliveryOrder>(record), decode_or::<PickupOrder>(record)) {
        (Some(o), _) => Some((o.requester, o.merchant)),
        (None, Some(o)) => Some((o.requester, o.merchant)),
        _ => None,
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
    Ok(decode_or::<PickupOrder>(&arrived(&update.original_action_address)?).is_some_and(|prior| prior.status == PickupStatus::Disputed))
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

/// The refund the store's answers add up to: every report it accepted --
/// for all it's worth, or the part it named -- or never answered, the
/// delivery's own included. The
/// store has the final say -- one it declined isn't refunded -- as it would
/// if you ordered from it directly. Never more than the reports cited are
/// worth together, which validation holds it to: two reports of the same
/// unit are worth it once.
fn refund_owed(terms: &Priced, issues: &[IssueView]) -> (Vec<ActionHash>, u64) {
    let refunded: Vec<&IssueView> = issues.iter().filter(|i| i.accepted != Some(false)).collect();
    let refunds = |i: &IssueView| i.refund.unwrap_or(i.value);
    // The delivery itself: its own worth, apart from any item's.
    let service: u64 = refunded.iter().filter(|i| i.service).map(|i| refunds(i)).sum();
    let items: Vec<&IssueView> = refunded.iter().filter(|i| !i.service).copied().collect();
    let lines = |of: &[&IssueView]| -> Vec<(u32, u32)> { of.iter().flat_map(|i| i.lines.iter().map(|l| (l.line, l.quantity))).collect() };
    let (parts, whole): (Vec<&IssueView>, Vec<&IssueView>) = items.iter().partition(|i| i.refund.is_some_and(|r| r < i.value));
    let worth = |of: &[&IssueView]| claimed_value(&terms.amounts(), terms.order_total, &lines(of));
    let owed = worth(&whole).saturating_add(parts.iter().filter_map(|i| i.refund).sum()).min(worth(&items));
    (refunded.iter().map(|i| i.issue.clone()).collect(), owed.saturating_add(service))
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
                        let hash = record_decision(DecisionWire::Outcome(OrderOutcome { order: order.clone(), outcome: Outcome::Delivered { proof: latest.action_address().clone() } , beacon: None }))?;
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
                            let hash = record_decision(DecisionWire::Outcome(OrderOutcome { order: order.clone(), outcome: Outcome::Delivered { proof: word.action_address().clone() } , beacon: None }))?;
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
    let collected_owed = match dispatch_integrity::lineage::Version::of(arrived(&basis)?) {
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
            let prior = arrived(&update.original_action_address)?;
            Ok((status(&prior) == Some(DeliveryStatus::Unanswered)).then_some(prior))
        }
        _ => Ok(None),
    }
}

/// The store's decision that the order was delivered (`outcome`), as it
/// reaches the driver: their completed delivery, and the pay they collect
/// on it. Finished: off every queue, the driver's included.
fn delivered_on(order: &ActionHash, delivery: &DeliveryOrder, outcome: &ActionHash) -> ExternResult<()> {
    // The bid the order names, validated: one not here yet holds the
    // decision back, rather than leave the driver's delivery uncounted.
    if let Some(bid) = delivery.accepted_bid.as_ref().map(arrived).transpose()?.and_then(|r| decode_or::<Bid>(&r)) {
        record_reputation_event(&bid.bidder, ReputationTargetWire::Driver(bid.bidder.clone()), order.clone(), ReputationEventKindWire::OrderCompleted, outcome.clone())?;
        let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: order.clone() }, vec![bid.bidder]);
    }
    crate::order_queues::retire(&crate::OrderParties::delivery(order, delivery)?)
}

/// Whether a delivered version came out of the customer's claim that it
/// never arrived.
fn came_out_of_claim(delivered: &Record) -> ExternResult<bool> {
    let ActionData::Update(update) = &delivered.action().data else { return Ok(false) };
    Ok(decode_or::<DeliveryOrder>(&arrived(&update.original_action_address)?).is_some_and(|prior| prior.status == DeliveryStatus::Disputed))
}

/// The store deciding the order never arrived, on the customer's claim
/// (`claim`): everyone's money goes back, and the driver's collateral pays
/// the store for the food -- recorded against the driver.
fn not_delivered(order: &ActionHash, claim: &Record, delivery: &DeliveryOrder) -> ExternResult<ActionHash> {
    let hash = record_decision(DecisionWire::Outcome(OrderOutcome { order: order.clone(), outcome: Outcome::NotDelivered { claim: claim.action_address().clone() } , beacon: None }))?;
    if let Some(bid_ref) = &delivery.accepted_bid {
        if let Some(bid) = decode_or::<Bid>(&arrived(bid_ref)?) {
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

/// The store settling, as delivered, a delivery its driver picked up that
/// nobody's said more of -- no proof it arrived, no claim it didn't -- once
/// its customer's time to say it never came has run, proved by its app
/// (`deliveries::get_store_steps_due`). The store and the driver are paid
/// as for any delivery; a customer who never got it appeals.
#[hdk_extern]
pub fn settle_stalled_delivery(input: crate::deliveries::TimedStepInput) -> ExternResult<ActionHash> {
    let order = original_action_of(input.order_ref)?;
    let (requester, merchant) = parties_of(&order)?;
    if merchant != agent_info()?.agent_initial_pubkey {
        return Err(guest("Only the order's store decides this."));
    }
    let decisions = decisions_of(&order)?;
    if decisions.delivered.is_some() || decisions.not_delivered.is_some() {
        return Err(guest("This order's outcome is already decided."));
    }
    let latest = resolve_latest(order.clone())?;
    let delivery = decode_or::<DeliveryOrder>(&latest).filter(|o| o.status == DeliveryStatus::PickedUp).ok_or(guest("This order isn't out with its driver."))?;
    if handshake_integrity_support::beacon::proves_past(input.beacon.as_ref(), lineage::stalled_delivery_settles_at(latest.action().timestamp())).is_err() {
        return Err(guest("The customer still has time to say it never came."));
    }
    let hash = record_decision(DecisionWire::Outcome(OrderOutcome { order: order.clone(), outcome: Outcome::Delivered { proof: latest.action_address().clone() }, beacon: input.beacon }))?;
    let driver = delivery.accepted_bid.as_ref().and_then(|b| get(b.clone(), GetOptions::default()).ok().flatten()).and_then(|r| decode_or::<Bid>(&r)).map(|bid| bid.bidder);
    let _ = send_remote_signal(crate::signals::RemoteSignal::Payment { order_hash: order.clone() }, std::iter::once(requester).chain(driver).collect());
    crate::order_queues::retire(&crate::OrderParties::delivery(&order, &delivery)?)?;
    Ok(hash)
}
