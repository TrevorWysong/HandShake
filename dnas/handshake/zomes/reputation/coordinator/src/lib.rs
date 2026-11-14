//! Coordinator zome for reputation: `record_event` (called by a
//! counterparty, never by the subject themselves) and `get_reputation_summary`,
//! a derived, UI-cache-only read -- see the integrity crate's doc comment
//! on why this is never the actual trust source of truth -- plus store,
//! driver and menu-item reviews and their ratings.
//!
//! Every summary is summed from link tags that validation checks against
//! the entry each link points at (`review_tag`/`event_tag`), counting one
//! vote per author per order -- never from a summary someone else wrote,
//! which nobody can check is complete. Each reaches back over the network's
//! `reputation_window` only (`recent`): the authorities filter by time, so a
//! summary costs what happened lately, not a busy store's whole history.
//!
//! Every read and write is keyed by a scoped target (`ReputationTarget`/
//! `ReviewTarget`), never a bare agent -- see the integrity crate's module
//! doc comment for why.

use hdk::prelude::*;
use handshake_coordinator_support::{all_arrived, arrived, call_local, call_role, decode_or, get_links_many, guest, original_action_of, read_records, resolve_latest, written};
use std::collections::BTreeMap;
use reputation_integrity::*;

mod customers;
mod findings;
pub use customers::*;
pub use findings::*;

/// Where a `ReputationTarget`'s events live: the link base and type.
fn event_links(target: &ReputationTarget) -> (AnyLinkableHash, LinkTypes) {
    match target {
        ReputationTarget::Store(catalog_ref) => (catalog_ref.clone().into(), LinkTypes::StoreToEvent),
        ReputationTarget::Driver(agent) => (agent.clone().into(), LinkTypes::DriverToEvent),
        ReputationTarget::Customer(agent) => (agent.clone().into(), LinkTypes::CustomerToEvent),
    }
}

/// Who or what a record is about: a person, or a store.
enum Subject<'a> {
    Person(&'a AgentPubKey),
    Store(&'a ActionHash),
}

/// Every base a target's record lives under -- its own, and those it carries
/// on from: for a person, each key their account had before (the account
/// zome's `lineage`); for a store, each store it was moved from (the catalog
/// zome's `store_line`). A record follows its subject to a new key.
fn bases_of(base: AnyLinkableHash, subject: Subject) -> ExternResult<Vec<AnyLinkableHash>> {
    let mut bases = vec![base];
    let earlier: Result<Vec<AnyLinkableHash>, _> = match subject {
        Subject::Person(agent) => call_local::<_, Vec<AgentPubKey>>("account", "lineage", agent.clone())?.map(|keys| keys.into_iter().map(Into::into).collect()),
        Subject::Store(catalog) => call_local::<_, Vec<ActionHash>>("catalog", "store_line", catalog.clone())?.map(|stores| stores.into_iter().map(Into::into).collect()),
    };
    // A line that can't be read is an error, never "no earlier keys": that
    // would show a record without the history it carries on from.
    bases.extend(earlier.map_err(|why| guest(format!("couldn't read what this record carries on from: {why}")))?);
    Ok(bases)
}

fn subject_of(target: &ReputationTarget) -> Subject<'_> {
    match target {
        ReputationTarget::Store(catalog) => Subject::Store(catalog),
        ReputationTarget::Driver(agent) | ReputationTarget::Customer(agent) => Subject::Person(agent),
    }
}

/// The links of `link_type` under each of `bases` made within the network's
/// `reputation_window`, read together.
fn recent(bases: Vec<AnyLinkableHash>, link_type: LinkTypes) -> ExternResult<Vec<Link>> {
    Ok(recent_each(bases, link_type)?.into_iter().flatten().collect())
}

/// `recent`, each base's links apart.
fn recent_each(bases: Vec<AnyLinkableHash>, link_type: LinkTypes) -> ExternResult<Vec<Vec<Link>>> {
    within_each(bases, link_type, handshake_governance::reputation_window())
}

/// The links of `link_type` under each of `bases` made within `window`,
/// each base's apart, read together.
fn within_each(bases: Vec<AnyLinkableHash>, link_type: LinkTypes, window: std::time::Duration) -> ExternResult<Vec<Vec<Link>>> {
    let since = (sys_time()? - window).unwrap_or(Timestamp::from_micros(0));
    let mut queries = Vec::with_capacity(bases.len());
    for base in bases {
        let mut query = LinkQuery::try_new(base, link_type)?;
        query.after = Some(since);
        queries.push(query);
    }
    get_links_many(queries)
}

/// Where a `ReviewTarget`'s reviews live.
fn review_links(target: &ReviewTarget) -> (AnyLinkableHash, LinkTypes) {
    match target {
        ReviewTarget::Store(catalog_ref) => (catalog_ref.clone().into(), LinkTypes::StoreToReview),
        ReviewTarget::Driver(agent) => (agent.clone().into(), LinkTypes::DriverToReview),
    }
}

/// Each rating under `base`, one per author per order: a customer who
/// (with a modified client) reviewed the same order twice still counts
/// once. Read from the links' validated tags alone -- one network read,
/// however many reviews there are.
fn ratings(bases: Vec<AnyLinkableHash>, link_type: LinkTypes) -> ExternResult<Vec<(AgentPubKey, u8)>> {
    Ok(votes(recent(bases, link_type)?))
}

/// The ratings in `links`' tags, one per author per order.
fn votes(links: Vec<Link>) -> Vec<(AgentPubKey, u8)> {
    let mut votes: BTreeMap<(AgentPubKey, Vec<u8>), u8> = BTreeMap::new();
    for link in links {
        let tag = link.tag.into_inner();
        let (Some(&rating), Some(order)) = (tag.first(), tag.get(1..)) else { continue };
        if (1..=5).contains(&rating) {
            votes.entry((link.author, order.to_vec())).or_insert(rating);
        }
    }
    votes.into_iter().map(|((author, _), rating)| (author, rating)).collect()
}

/// Which of `reviewers` have rated an order from a store none of `owners`
/// owns -- each such review is of a real order they had, from someone else.
/// One who's only ever rated this store could be its owner's second
/// account. With its owners unknown, two stores rated stand in for one
/// elsewhere. Every reviewer's reviews are read together.
fn rated_elsewhere(reviewers: &[AgentPubKey], owners: &[AgentPubKey]) -> ExternResult<BTreeMap<AgentPubKey, bool>> {
    let queries = reviewers.iter().map(|reviewer| LinkQuery::try_new(reviewer.clone(), LinkTypes::ReviewerToReview)).collect::<ExternResult<Vec<_>>>()?;
    let owner_tags: Vec<Vec<u8>> = owners.iter().map(|owner| reviewer_tag(owner).into_inner()).collect();
    let mut elsewhere = BTreeMap::new();
    for (reviewer, links) in reviewers.iter().zip(get_links_many(queries)?) {
        let rated: std::collections::BTreeSet<Vec<u8>> = links.into_iter().filter(|link| &link.author == reviewer).map(|link| link.tag.into_inner()).collect();
        let others = rated.iter().filter(|tag| !owner_tags.contains(tag)).count();
        elsewhere.insert(reviewer.clone(), others >= if owners.is_empty() { 2 } else { 1 });
    }
    Ok(elsewhere)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordEventInput {
    pub target: ReputationTarget,
    pub order_ref: ActionHash,
    pub kind: ReputationEventKind,
    /// What the event rests on: the order's version it records, or its
    /// store's decision (see `reputation_integrity::validate_event`).
    pub basis: ActionHash,
}

/// Called by the counterparty after a completed/cancelled/disputed order --
/// typically invoked cross-zome from `attestation` or `dispatch` once a
/// receipt or cancellation is finalized, rather than called directly by a
/// client.
#[hdk_extern]
pub fn record_event(input: RecordEventInput) -> ExternResult<Record> {
    let counterparty = agent_info()?.agent_initial_pubkey;
    let (base, event_link) = event_links(&input.target);
    let tag = event_tag(&input.kind, &input.order_ref);
    let event = ReputationEvent { target: input.target, counterparty, order_ref: input.order_ref, basis: input.basis, kind: input.kind, recorded_at: sys_time()? };
    let action_hash = create_entry(&EntryTypes::ReputationEvent(event))?;
    create_link(base, action_hash.clone(), event_link, tag)?;
    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ReputationSummary {
    pub completed_count: u32,
    pub cancelled_by_them_count: u32,
    pub dispute_raised_count: u32,
    pub dispute_resolved_against_count: u32,
    /// Deliveries the driver left before picking them up.
    pub dropped_count: u32,
    /// Times a store kept a checked-in driver waiting past the network's wait.
    pub late_count: u32,
    /// Offers a driver let lapse, or turned down, without committing.
    pub lapsed_count: u32,
    /// Drivers' reports that a store wouldn't check them in -- from drivers
    /// who've delivered for enough different stores (`min_reporter_stores`).
    pub check_in_refused_count: u32,
    /// Deliveries the customer wasn't there to take, as their store upheld.
    #[serde(default)]
    pub no_show_count: u32,
    pub total_collateral_forfeited: u64,
    /// How many different established stores found a customer's reports
    /// weren't made in good faith, but for orders whose appeal they won
    /// (docs/REPUTATION.md, phase 2). Shown to other stores only from
    /// `min_flagging_stores`.
    #[serde(default)]
    pub bad_faith_stores: u32,
    /// Deliveries a store found the driver at fault for, having refunded
    /// the customer (phase 3).
    #[serde(default)]
    pub faulted_count: u32,
}

/// A UI-display cache only -- see the integrity crate's doc comment. Do not
/// use this alone to decide whether to accept a bid; check the agent's real
/// activity chain and any outstanding warrants first. Each kind of event
/// counts once per recorder per order.
/// `event_tag`'s code for a driver's report that a store wouldn't check them
/// in.
const CHECK_IN_REFUSED: u8 = 7;
/// `event_tag`'s code for a completed order.
const COMPLETED: u8 = 0;

/// How many different stores have recorded a completed delivery by
/// `driver` -- each store records its own, so each is a different agent.
fn stores_delivered_for(driver: &AgentPubKey) -> ExternResult<u32> {
    let (base, event_link) = event_links(&ReputationTarget::Driver(driver.clone()));
    Ok(stores_in(&recent(vec![base], event_link)?))
}

/// How many different stores recorded a completed delivery among a
/// driver's event links.
fn stores_in(links: &[Link]) -> u32 {
    let mut stores: Vec<&AgentPubKey> = Vec::new();
    for link in links {
        if link.tag.0.first() == Some(&COMPLETED) && !stores.contains(&&link.author) {
            stores.push(&link.author);
        }
    }
    stores.len() as u32
}

#[hdk_extern]
pub fn get_reputation_summary(target: ReputationTarget) -> ExternResult<ReputationSummary> {
    let (base, event_link) = event_links(&target);
    let links = recent(bases_of(base, subject_of(&target))?, event_link)?;
    // Each order counts once per kind of event, whoever recorded it: two of
    // an order's parties can each record the same fact (a cancellation), and
    // it's still one fact.
    let mut events: BTreeMap<(u8, Vec<u8>), u64> = BTreeMap::new();
    // A driver's report that a store wouldn't check them in counts only if
    // they've completed enough deliveries -- a throwaway identity's reports
    // don't. Each reporter is looked up once.
    let mut seasoned: BTreeMap<AgentPubKey, bool> = BTreeMap::new();
    // A store's findings that a customer's reports weren't made in good
    // faith count by store, not by order (`flagging_stores`).
    let mut flags: Vec<(AgentPubKey, ActionHash)> = Vec::new();
    for link in links {
        let tag = link.tag.into_inner();
        if tag.len() != 1 + 8 + 39 {
            continue;
        }
        if tag[0] == BAD_FAITH {
            flags.push((link.author, ActionHash::from_raw_39(tag[9..].to_vec())));
            continue;
        }
        if tag[0] == CHECK_IN_REFUSED {
            let reporter = link.author.clone();
            let counts = match seasoned.get(&reporter) {
                Some(counts) => *counts,
                None => {
                    let counts = stores_delivered_for(&reporter)? >= handshake_governance::min_reporter_stores();
                    seasoned.insert(reporter, counts);
                    counts
                }
            };
            if !counts {
                continue;
            }
        }
        let amount = u64::from_be_bytes(tag[1..9].try_into().expect("checked length"));
        events.entry((tag[0], tag[9..].to_vec())).or_insert(amount);
    }
    let mut summary = ReputationSummary::default();
    for ((code, _), amount) in events {
        match code {
            0 => summary.completed_count += 1,
            1 => summary.cancelled_by_them_count += 1,
            2 => summary.dispute_raised_count += 1,
            3 => summary.dispute_resolved_against_count += 1,
            5 => summary.dropped_count += 1,
            6 => summary.late_count += 1,
            8 => summary.lapsed_count += 1,
            9 => summary.no_show_count += 1,
            CHECK_IN_REFUSED => summary.check_in_refused_count += 1,
            FAULTED => summary.faulted_count += 1,
            4 => summary.total_collateral_forfeited += amount,
            _ => {}
        }
    }
    summary.bad_faith_stores = flagging_stores(&flags)?;
    if let Some(earlier) = on_previous_network::<_, ReputationSummary>(&target, |t| ("get_reputation_summary", t))? {
        summary.merge(&earlier);
    }
    Ok(summary)
}

impl ReputationSummary {
    fn merge(&mut self, other: &Self) {
        self.completed_count += other.completed_count;
        self.cancelled_by_them_count += other.cancelled_by_them_count;
        self.dispute_raised_count += other.dispute_raised_count;
        self.dispute_resolved_against_count += other.dispute_resolved_against_count;
        self.dropped_count += other.dropped_count;
        self.late_count += other.late_count;
        self.lapsed_count += other.lapsed_count;
        self.check_in_refused_count += other.check_in_refused_count;
        self.no_show_count += other.no_show_count;
        self.total_collateral_forfeited += other.total_collateral_forfeited;
        self.bad_faith_stores += other.bad_faith_stores;
        self.faulted_count += other.faulted_count;
    }
}

/// Who or what `target` was on the previous version of the network, if it
/// came over in a migration (docs/MIGRATION.md) -- checked there by the account
/// and catalog zomes.
fn previous_target(target: &ReputationTarget) -> ExternResult<Option<ReputationTarget>> {
    Ok(match target {
        ReputationTarget::Store(catalog) => {
            let found = call_local::<_, Option<ActionHash>>("catalog", "imported_from", catalog.clone())?.map_err(|why| guest(format!("imported_from: {why}")))?;
            found.map(ReputationTarget::Store)
        }
        ReputationTarget::Driver(agent) | ReputationTarget::Customer(agent) => {
            let found = call_local::<_, Option<AgentPubKey>>("account", "arrived_from", agent.clone())?.map_err(|why| guest(format!("arrived_from: {why}")))?;
            found.map(|previous| match target {
                ReputationTarget::Driver(_) => ReputationTarget::Driver(previous),
                _ => ReputationTarget::Customer(previous),
            })
        }
    })
}

/// The same read of `target`'s record on the previous network, if it came
/// over from there -- its history is its own.
fn on_previous_network<I: Serialize + std::fmt::Debug, O: for<'de> Deserialize<'de> + std::fmt::Debug>(
    target: &ReputationTarget,
    request: impl FnOnce(ReputationTarget) -> (&'static str, I),
) -> ExternResult<Option<O>> {
    let Some(previous) = previous_target(target)? else { return Ok(None) };
    let (function, input) = request(previous);
    Ok(call_role("previous", "reputation", function, input).ok().and_then(Result::ok))
}

// --- store/driver reviews ---

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitReviewInput {
    pub target: ReviewTarget,
    pub order_original_action: ActionHash,
    pub rating: u8,
    pub comment: String,
}

/// Every review the caller has already left on this order, via its
/// `OrderToReview` links -- a small, per-order link set (at most one store
/// review and one driver review per order).
fn my_reviews_for_order(order_original_action: &ActionHash) -> ExternResult<Vec<(Record, Review)>> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(order_original_action.clone(), LinkTypes::OrderToReview)?.author(me), GetStrategy::default())?;
    let mut out = Vec::new();
    for link in links {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let record = arrived(&hash)?;
        if let Ok(Some(review)) = record.entry().to_app_option::<Review>() {
            out.push((record, review));
        }
    }
    Ok(out)
}

/// `order_original_action` is resolved to its *latest* record before being
/// written onto the `Review` as `order_ref` -- deliberately not the original
/// creation hash every other struct in this system uses for the same field
/// name, because `validate_review` needs to deterministically see the
/// order's real `Delivered` status and populated `accepted_bid`, neither of
/// which exist yet on the as-created record. This coordinator's own status
/// check is a fast-fail
/// convenience; `validate_review` is what actually enforces it.
///
/// One review per target per order, same as DoorDash/Uber Eats --
/// validation walks the author's chain for an earlier one
/// (`reputation_integrity::validate_review`); checked here first to say so.
#[hdk_extern]
pub fn submit_review(input: SubmitReviewInput) -> ExternResult<Record> {
    if input.rating < 1 || input.rating > 5 {
        return Err(guest("Choose between 1 and 5 stars."));
    }
    if my_reviews_for_order(&input.order_original_action)?.iter().any(|(_, r)| r.target == input.target) {
        return Err(guest("You've already rated this order."));
    }
    let order_record = resolve_latest(input.order_original_action.clone())?;
    let author = agent_info()?.agent_initial_pubkey;
    let created_at = sys_time()?;
    let review = Review {
        target: input.target.clone(),
        author,
        order_ref: order_record.action_address().clone(),
        rating: input.rating,
        comment: input.comment,
        created_at,
    };
    let action_hash = create_entry(&EntryTypes::Review(review))?;
    let (base, review_link) = review_links(&input.target);
    create_link(base, action_hash.clone(), review_link, review_tag(input.rating, &input.order_original_action))?;
    // Under its author too, with whose store it was: what lets a rating
    // tell a customer who's ordered elsewhere from a store's own account.
    if matches!(input.target, ReviewTarget::Store(_)) {
        let merchant = reviewed_store_owner(order_record.action_address())?.ok_or(guest("You can rate an order once you have it."))?;
        create_link(agent_info()?.agent_initial_pubkey, action_hash.clone(), LinkTypes::ReviewerToReview, reviewer_tag(&merchant))?;
    }
    create_link(input.order_original_action, action_hash.clone(), LinkTypes::OrderToReview, ())?;
    written(action_hash)
}

/// What the caller has already rated on this order -- lets an order screen
/// show "thanks for rating" instead of the rating form again after a
/// reload, rather than relying on in-memory UI state.
#[hdk_extern]
pub fn get_my_reviews_for_order(order_original_action: ActionHash) -> ExternResult<Vec<Record>> {
    Ok(my_reviews_for_order(&order_original_action)?.into_iter().map(|(record, _)| record).collect())
}

const REVIEW_PAGE_SIZE: usize = 20;

#[derive(Serialize, Deserialize, Debug)]
pub struct GetReviewsInput {
    pub target: ReviewTarget,
    /// Page cursor -- pass back the previous call's `next_before` to load
    /// older reviews. `None` starts from the newest.
    pub before: Option<Timestamp>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ReviewsPage {
    pub reviews: Vec<Record>,
    pub next_before: Option<Timestamp>,
}

/// One newest-first page of the reviews linked from `base`, keeping only
/// those `belongs` accepts (link validation already guarantees it; checking
/// again keeps a list honest even if that ever regressed).
fn review_page(base: AnyLinkableHash, link_type: LinkTypes, before: Option<Timestamp>, belongs: impl Fn(&Record) -> bool) -> ExternResult<ReviewsPage> {
    let mut query = LinkQuery::try_new(base, link_type)?;
    query.before = before;
    let (links, next_before) = handshake_coordinator_support::links::newest_first_page(query, REVIEW_PAGE_SIZE)?;
    // Reviews never change: the page's records, read together.
    let targets: Vec<ActionHash> = links.into_iter().filter_map(|link| link.target.into_action_hash()).collect();
    let reviews = read_records(&targets)?.into_iter().flatten().filter(|record| belongs(record)).collect();
    Ok(ReviewsPage { reviews, next_before })
}

/// A store's or driver's reviews, newest first -- a busy store accumulates
/// reviews forever, and a store page only ever shows the most recent
/// handful (the average comes from `get_rating_summary`).
#[hdk_extern]
pub fn get_reviews_for(input: GetReviewsInput) -> ExternResult<ReviewsPage> {
    let (base, review_link) = review_links(&input.target);
    review_page(base, review_link, input.before, |record| {
        record.entry().to_app_option::<Review>().ok().flatten().is_some_and(|review| review.target == input.target)
    })
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct RatingSummary {
    /// The reviews the rating's made of, and their stars.
    pub count: u32,
    pub rating_sum: u32,
    /// A store's reviews left out of its rating: from customers who haven't
    /// rated an order from another store yet. Shown, but not counted.
    #[serde(default)]
    pub uncounted: u32,
}

/// The star rating shown on a store card/page or a driver's bid.
#[hdk_extern]
pub fn get_rating_summary(target: ReviewTarget) -> ExternResult<RatingSummary> {
    let (base, review_link) = review_links(&target);
    let subject = match &target {
        ReviewTarget::Driver(agent) => Subject::Person(agent),
        ReviewTarget::Store(catalog) => Subject::Store(catalog),
    };
    let bases = bases_of(base, subject)?;
    // A store's owners -- of it, and of each store it was moved from -- whose
    // other accounts' reviews don't count. A driver's reviews all do: each
    // comes from a different store's order.
    let owners: Option<Vec<AgentPubKey>> = match &target {
        ReviewTarget::Store(_) => {
            let catalogs: Vec<ActionHash> = bases.iter().filter_map(|base| base.clone().into_action_hash()).collect();
            // Every one of them: an owner left out would have their own
            // accounts' reviews counted.
            Some(all_arrived(&catalogs, GetStrategy::default())?.into_iter().map(|record| record.action().author().clone()).collect())
        }
        ReviewTarget::Driver(_) => None,
    };
    let votes = ratings(bases, review_link)?;
    let elsewhere = match &owners {
        Some(owners) => {
            let reviewers: Vec<AgentPubKey> = votes.iter().map(|(reviewer, _)| reviewer.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
            Some(rated_elsewhere(&reviewers, owners)?)
        }
        None => None,
    };
    let mut summary = RatingSummary::default();
    for (reviewer, rating) in votes {
        let counts = elsewhere.as_ref().is_none_or(|elsewhere| elsewhere.get(&reviewer).copied().unwrap_or(false));
        if counts {
            summary.count += 1;
            summary.rating_sum += rating as u32;
        } else {
            summary.uncounted += 1;
        }
    }
    let as_reputation = match &target {
        ReviewTarget::Store(catalog) => ReputationTarget::Store(catalog.clone()),
        ReviewTarget::Driver(agent) => ReputationTarget::Driver(agent.clone()),
    };
    let earlier = on_previous_network::<_, RatingSummary>(&as_reputation, |previous| {
        let review = match previous {
            ReputationTarget::Store(catalog) => ReviewTarget::Store(catalog),
            ReputationTarget::Driver(agent) | ReputationTarget::Customer(agent) => ReviewTarget::Driver(agent),
        };
        ("get_rating_summary", review)
    })?;
    if let Some(earlier) = earlier {
        summary.count += earlier.count;
        summary.rating_sum += earlier.rating_sum;
        summary.uncounted += earlier.uncounted;
    }
    Ok(summary)
}

// --- per-item ratings -- same shape as the store/driver reviews above,
// keyed by a MenuItem's action hash instead ---

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitItemReviewInput {
    pub item_ref: ActionHash,
    pub order_original_action: ActionHash,
    pub rating: u8,
    pub comment: String,
}

/// Same `resolve_latest`-before-writing treatment as `submit_review`'s own
/// doc comment explains -- `validate_item_review` needs to deterministically
/// see the order's real `Delivered` status and final `item_refs`.
#[hdk_extern]
pub fn submit_item_review(input: SubmitItemReviewInput) -> ExternResult<Record> {
    if input.rating < 1 || input.rating > 5 {
        return Err(guest("Choose between 1 and 5 stars."));
    }
    // Once per item per order -- validation's rule, told first, read back as
    // far as it reads: to when the order was placed.
    let placed = get(input.order_original_action.clone(), GetOptions::default())?.ok_or(guest("order not found"))?.action().timestamp();
    let reviewed = handshake_coordinator_support::chain::mine(&[EntryType::try_from(UnitEntryTypes::ItemReview)?]).since(placed).any(|r| {
        decode_or::<ItemReview>(r).is_some_and(|earlier| earlier.item_ref == input.item_ref && original_action_of(earlier.order_ref).is_ok_and(|order| order == input.order_original_action))
    })?;
    if reviewed {
        return Err(guest("You've already rated this item from this order."));
    }
    let order_record = resolve_latest(input.order_original_action.clone())?;
    let author = agent_info()?.agent_initial_pubkey;
    let created_at = sys_time()?;
    let review = ItemReview {
        item_ref: input.item_ref.clone(),
        author,
        order_ref: order_record.action_address().clone(),
        rating: input.rating,
        comment: input.comment,
        created_at,
    };
    let action_hash = create_entry(&EntryTypes::ItemReview(review))?;
    create_link(input.item_ref, action_hash.clone(), LinkTypes::ItemToReview, review_tag(input.rating, &input.order_original_action))?;
    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ItemRatingSummary {
    pub count: u32,
    pub rating_sum: u32,
}

/// A menu item's rating. `average` is the caller's to compute
/// (`rating_sum / count`; `count == 0` means no reviews yet).
#[hdk_extern]
pub fn get_item_rating_summary(item_ref: ActionHash) -> ExternResult<ItemRatingSummary> {
    Ok(item_summary(ratings(vec![item_ref.into()], LinkTypes::ItemToReview)?))
}

/// The most items `get_item_rating_summaries` reads at once.
pub const ITEM_BATCH: usize = 100;

/// Each of `item_refs`' ratings, in order -- a menu's, read together.
#[hdk_extern]
pub fn get_item_rating_summaries(item_refs: Vec<ActionHash>) -> ExternResult<Vec<ItemRatingSummary>> {
    if item_refs.len() > ITEM_BATCH {
        return Err(guest("Ask for fewer items at once."));
    }
    let bases = item_refs.into_iter().map(Into::into).collect();
    Ok(recent_each(bases, LinkTypes::ItemToReview)?.into_iter().map(|links| item_summary(votes(links))).collect())
}

fn item_summary(ratings: Vec<(AgentPubKey, u8)>) -> ItemRatingSummary {
    ItemRatingSummary { count: ratings.len() as u32, rating_sum: ratings.iter().map(|&(_, r)| r as u32).sum() }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ItemReviewsInput {
    pub item_ref: ActionHash,
    /// Page cursor -- the previous page's `next_before`. `None` starts from
    /// the newest review.
    pub before: Option<Timestamp>,
}

/// A menu item's reviews, newest first (see `get_reviews_for`).
#[hdk_extern]
pub fn get_item_reviews(input: ItemReviewsInput) -> ExternResult<ReviewsPage> {
    review_page(input.item_ref.clone().into(), LinkTypes::ItemToReview, input.before, |record| {
        record.entry().to_app_option::<ItemReview>().ok().flatten().is_some_and(|review| review.item_ref == input.item_ref)
    })
}

#[cfg(feature = "test-utils")]
mod test_utils {
    use hdk::prelude::*;
    use reputation_integrity::{CustomerRating, EntryTypes, LinkTypes, MarkReply, Review};
    handshake_coordinator_support::raw_link_test_externs!(StoreToEvent, DriverToEvent, CustomerToEvent, StoreToReview, DriverToReview, OrderToReview, ItemToReview, ReviewerToReview, EventToReply, CustomerToRating, RaterToRating, OwnerToBlocks);

    /// Writes a reply to a finding exactly as given, past the coordinator's
    /// checks, so a test can prove what validation refuses.
    #[hdk_extern]
    pub fn create_raw_mark_reply_for_testing(reply: MarkReply) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::MarkReply(reply))
    }

    /// Writes a rating of a customer exactly as given, past the
    /// coordinator's checks, so a test can prove what validation refuses.
    #[hdk_extern]
    pub fn create_raw_customer_rating_for_testing(rating: CustomerRating) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::CustomerRating(rating))
    }

    /// Writes a review exactly as given, past the coordinator's checks --
    /// what a modified client could -- so a test can prove what validation
    /// refuses.
    #[hdk_extern]
    pub fn create_raw_review_for_testing(review: Review) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::Review(review))
    }
}
