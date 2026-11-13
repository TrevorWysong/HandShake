//! A store's findings on a customer's report (docs/REPUTATION.md, phases 2
//! and 3): that it wasn't made in good faith (`BadFaithReport`, on the
//! customer), or that the driver was at fault for a poor delivery
//! (`DeliveryFaulted`, on the driver). Each is the store's word, so each is
//! attributed, reasoned from a fixed list, shown to its subject, answerable
//! with one public reply -- and a customer's counts only from established
//! stores, once per store, unless an appeal they won says otherwise.
//! Validation holds what each may cite (`reputation_integrity`,
//! `validate_finding`); this reads and writes them.

use super::*;

/// `event_tag`'s code for a store's finding a report wasn't made in good faith.
pub(crate) const BAD_FAITH: u8 = 10;
/// `event_tag`'s code for a store's finding a driver at fault.
pub(crate) const FAULTED: u8 = 11;

// --- what's read from the dispatch zome: only the fields used ---

#[derive(Deserialize, Debug)]
struct IssueItemsWire {
    customer: AgentPubKey,
    catalog_ref: ActionHash,
    driver: Option<AgentPubKey>,
}

#[derive(Deserialize, Debug)]
struct IssueWire {
    issue: ActionHash,
    accepted: Option<bool>,
    service: bool,
    answer: Option<ActionHash>,
    evidence: Option<EvidenceWire>,
}

#[derive(Deserialize, Debug)]
struct EvidenceWire {
    note: String,
    photo_data_uri: String,
}

#[derive(Deserialize, Debug)]
struct AppealWire {
    ruling: Option<RulingWire>,
}

#[derive(Deserialize, Debug)]
struct RulingWire {
    award: u64,
}

fn dispatch<I: Serialize + std::fmt::Debug, O: for<'de> Deserialize<'de> + std::fmt::Debug>(function: &str, input: I) -> ExternResult<O> {
    call_local::<_, O>("dispatch", function, input)?.map_err(|why| guest(format!("{function}: {why}")))
}

// --- recording ---

/// What a store finds on a report.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finding {
    /// The report, about items it declined, wasn't made in good faith.
    BadFaith(BadFaithReason),
    /// The driver was at fault for the delivery it refunded.
    DriverAtFault(FaultReason),
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordFindingInput {
    /// The order's original action.
    pub order: ActionHash,
    /// The report.
    pub issue: ActionHash,
    pub finding: Finding,
}

/// The caller's store recording its finding on a report it's answered --
/// in a call of its own, after the answer, so a finding that doesn't
/// validate never undoes it. Once per report.
#[hdk_extern]
pub fn record_finding(input: RecordFindingInput) -> ExternResult<Record> {
    let order = original_action_of(input.order)?;
    let items: IssueItemsWire = dispatch("get_issue_items", order.clone())?;
    let views: Vec<IssueWire> = dispatch("get_issues_for_order", order.clone())?;
    let view = views.into_iter().find(|v| v.issue == input.issue).ok_or(guest("That report isn't on this order."))?;
    let answer = view.answer.clone().ok_or(guest("Answer the report first."))?;
    let (target, kind) = match input.finding {
        // Validation's rules, told first.
        Finding::BadFaith(reason) => {
            if view.accepted != Some(false) || view.service {
                return Err(guest("You can say a report wasn't made in good faith only about items, once you've declined it."));
            }
            (ReputationTarget::Customer(items.customer), ReputationEventKind::BadFaithReport { reason })
        }
        Finding::DriverAtFault(reason) => {
            if view.accepted != Some(true) || !view.service {
                return Err(guest("You can hold the driver at fault only for a delivery you've refunded the customer for."));
            }
            // The store's app asks for the customer's word, too: a note or a
            // photo the driver can read.
            if view.evidence.as_ref().is_none_or(|e| e.note.trim().is_empty() && e.photo_data_uri.is_empty()) {
                return Err(guest("The customer didn't say what went wrong, so the driver would have nothing to answer."));
            }
            let driver = items.driver.ok_or(guest("No driver delivered this order."))?;
            (ReputationTarget::Driver(driver), ReputationEventKind::DeliveryFaulted { reason })
        }
    };
    let code = event_tag(&kind, &order).into_inner()[0];
    if mine_on(&target, &order, code)? {
        return Err(guest("You've already said so about this order."));
    }
    record_event(RecordEventInput { target, order_ref: order, kind, basis: answer })
}

/// Whether the caller has already recorded a finding of `code` about
/// `target` on `order`.
fn mine_on(target: &ReputationTarget, order: &ActionHash, code: u8) -> ExternResult<bool> {
    let (base, link_type) = event_links(target);
    let query = LinkQuery::try_new(base, link_type)?.author(agent_info()?.agent_initial_pubkey);
    Ok(get_links(query, GetStrategy::default())?.into_iter().any(|link| link.tag.0.first() == Some(&code) && link.tag.0.get(9..) == Some(order.get_raw_39())))
}

// --- replying ---

#[derive(Serialize, Deserialize, Debug)]
pub struct ReplyInput {
    /// The finding replied to.
    pub event: ActionHash,
    pub text: String,
}

/// The caller answering a finding about them -- once, publicly.
#[hdk_extern]
pub fn reply_to_finding(input: ReplyInput) -> ExternResult<Record> {
    let me = agent_info()?.agent_initial_pubkey;
    let event = decode_or::<ReputationEvent>(&arrived(&input.event)?).ok_or(guest("That isn't a finding."))?;
    let about_me = match (&event.kind, &event.target) {
        (ReputationEventKind::BadFaithReport { .. }, ReputationTarget::Customer(agent)) | (ReputationEventKind::DeliveryFaulted { .. }, ReputationTarget::Driver(agent)) => agent == &me,
        _ => false,
    };
    if !about_me {
        return Err(guest("You can only reply to what a store said about you."));
    }
    if input.text.trim().is_empty() {
        return Err(guest("Say something in your reply."));
    }
    if input.text.chars().count() > MAX_REPLY_CHARS {
        return Err(guest("Keep your reply short."));
    }
    if reply_to(&input.event, &me)?.is_some() {
        return Err(guest("You've already replied to this."));
    }
    let hash = create_entry(&EntryTypes::MarkReply(MarkReply { event: input.event.clone(), text: input.text.trim().to_string() }))?;
    create_link(input.event, hash.clone(), LinkTypes::EventToReply, ())?;
    written(hash)
}

/// `subject`'s reply to the finding `event`, if they've made one -- only
/// theirs: anyone else's link is ignored.
fn reply_to(event: &ActionHash, subject: &AgentPubKey) -> ExternResult<Option<String>> {
    let query = LinkQuery::try_new(event.clone(), LinkTypes::EventToReply)?.author(subject.clone());
    for link in get_links(query, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        // Validated with its link: one not here yet is an error, never no reply.
        if let Some(reply) = decode_or::<MarkReply>(&arrived(&hash)?) {
            return Ok(Some(reply.text));
        }
    }
    Ok(None)
}

// --- reading ---

/// A finding about someone, as anyone may read it.
#[derive(Serialize, Deserialize, Debug)]
pub struct FindingView {
    pub event: ActionHash,
    pub order: ActionHash,
    pub at: Timestamp,
    pub finding: Finding,
    /// Whether it counts on their record: a customer's, only from an
    /// established store, unless an appeal they won says otherwise.
    pub counts: bool,
    pub reply: Option<String>,
}

/// Every finding about a customer or driver within the network's
/// reputation window, newest first -- for its subject, and for those it's
/// shown to (docs/REPUTATION.md).
#[hdk_extern]
pub fn get_findings(target: ReputationTarget) -> ExternResult<Vec<FindingView>> {
    let (code, subject) = match &target {
        ReputationTarget::Customer(agent) => (BAD_FAITH, agent.clone()),
        ReputationTarget::Driver(agent) => (FAULTED, agent.clone()),
        ReputationTarget::Store(_) => return Ok(Vec::new()),
    };
    let (base, link_type) = event_links(&target);
    let links: Vec<Link> = recent(bases_of(base, subject_of(&target))?, link_type)?.into_iter().filter(|link| link.tag.0.first() == Some(&code) && link.tag.0.len() == 1 + 8 + 39).collect();
    let mut standing = Standing::default();
    let mut views = Vec::with_capacity(links.len());
    for link in links {
        let Some(event) = link.target.clone().into_action_hash() else { continue };
        let tag = link.tag.0;
        let reason = u64::from_be_bytes(tag[1..9].try_into().expect("checked length"));
        let order = ActionHash::from_raw_39(tag[9..].to_vec());
        let (finding, counts) = match code {
            BAD_FAITH => (Finding::BadFaith(bad_faith_reason(reason)), standing.counts(&link.author, &order)?),
            _ => (Finding::DriverAtFault(fault_reason(reason)), true),
        };
        views.push(FindingView { reply: reply_to(&event, &subject)?, event, order, at: link.timestamp, finding, counts });
    }
    views.sort_by_key(|v| std::cmp::Reverse(v.at));
    Ok(views)
}

/// How many different established stores found a customer's reports
/// weren't made in good faith, among `flags` -- each (store owner, order) --
/// unless an appeal on that order says otherwise.
pub(crate) fn flagging_stores(flags: &[(AgentPubKey, ActionHash)]) -> ExternResult<u32> {
    let mut standing = Standing::default();
    let mut stores: Vec<&AgentPubKey> = Vec::new();
    for (owner, order) in flags {
        if !stores.contains(&owner) && standing.counts(owner, order)? {
            stores.push(owner);
        }
    }
    Ok(stores.len() as u32)
}

/// Whether a store's finding on an order counts, each store looked up once.
#[derive(Default)]
struct Standing {
    established: BTreeMap<ActionHash, bool>,
}

impl Standing {
    /// A finding by `owner` on `order` counts if the order's store is
    /// established and no appeal on it was won.
    fn counts(&mut self, owner: &AgentPubKey, order: &ActionHash) -> ExternResult<bool> {
        let items: IssueItemsWire = dispatch("get_issue_items", order.clone())?;
        let established = match self.established.get(&items.catalog_ref) {
            Some(known) => *known,
            None => {
                let known = established(&items.catalog_ref, owner)?;
                self.established.insert(items.catalog_ref.clone(), known);
                known
            }
        };
        Ok(established && !appeal_won(order)?)
    }
}

/// Whether a store has enough completed orders, from enough different
/// customers, for its findings to count: one just opened -- or opened to
/// flag -- doesn't. Its owner's own completions don't count toward either.
fn established(catalog: &ActionHash, owner: &AgentPubKey) -> ExternResult<bool> {
    let (base, link_type) = event_links(&ReputationTarget::Store(catalog.clone()));
    let mut orders: Vec<Vec<u8>> = Vec::new();
    let mut customers: Vec<AgentPubKey> = Vec::new();
    for link in recent(vec![base], link_type)? {
        let tag = link.tag.0;
        if tag.first() != Some(&COMPLETED) || &link.author == owner {
            continue;
        }
        if let Some(order) = tag.get(9..) {
            if !orders.iter().any(|o| o == order) {
                orders.push(order.to_vec());
            }
        }
        if !customers.contains(&link.author) {
            customers.push(link.author);
        }
    }
    Ok(orders.len() as u32 >= handshake_governance::min_flagger_orders() && customers.len() as u32 >= handshake_governance::min_flagger_customers())
}

/// Whether the order's customer appealed it and the arbiter awarded them
/// anything: the store's view of their reports didn't stand.
fn appeal_won(order: &ActionHash) -> ExternResult<bool> {
    let appeal: Option<AppealWire> = dispatch("get_appeal_for_order", order.clone())?;
    Ok(appeal.and_then(|a| a.ruling).is_some_and(|r| r.award > 0))
}

/// A reason from its place in `event_tag`'s amount -- `Other` for one this
/// version doesn't know.
fn bad_faith_reason(index: u64) -> BadFaithReason {
    [BadFaithReason::ItemWasIncluded, BadFaithReason::EvidenceDoesNotMatch, BadFaithReason::RepeatedClaim, BadFaithReason::Other].get(index as usize).copied().unwrap_or(BadFaithReason::Other)
}

fn fault_reason(index: u64) -> FaultReason {
    [FaultReason::Late, FaultReason::ColdOrSpilled, FaultReason::WrongPlace, FaultReason::Conduct, FaultReason::Other].get(index as usize).copied().unwrap_or(FaultReason::Other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_read_back_from_their_tag() {
        for reason in [BadFaithReason::ItemWasIncluded, BadFaithReason::EvidenceDoesNotMatch, BadFaithReason::RepeatedClaim, BadFaithReason::Other] {
            assert_eq!(bad_faith_reason(reason as u64), reason);
        }
        for reason in [FaultReason::Late, FaultReason::ColdOrSpilled, FaultReason::WrongPlace, FaultReason::Conduct, FaultReason::Other] {
            assert_eq!(fault_reason(reason as u64), reason);
        }
        assert_eq!(bad_faith_reason(99), BadFaithReason::Other, "a reason from a later version reads as other");
    }
}
