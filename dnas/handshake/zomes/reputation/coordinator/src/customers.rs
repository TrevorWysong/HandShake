//! Phase 4 (docs/REPUTATION.md): customers rated by the stores and drivers
//! who served them, and blocks between any two parties. A customer's score
//! is the share of thumbs-up over the latest word of their recent raters --
//! established stores and drivers who don't rate most customers down, and
//! never a thumbs-down from whoever a report of the customer's on that order
//! is about -- shown once there are enough; a block hides a pair from each
//! other, whichever made it.

use super::*;
use dispatch_types::{DeliveryOrder, DeliveryStatus, PickupOrder, PickupStatus};
use std::collections::BTreeSet;

// --- rating customers ---

#[derive(Serialize, Deserialize, Debug)]
pub struct RateCustomerInput {
    /// The order's original action.
    pub order: ActionHash,
    pub up: bool,
    /// Why, for a thumbs-down.
    pub reason: Option<CustomerReason>,
}

/// An order as a rating needs it: who and where from, and where it stands.
struct Rated {
    customer: AgentPubKey,
    merchant: AgentPubKey,
    catalog_ref: ActionHash,
    done: bool,
    disputed: bool,
}

fn order_terms(latest: &Record) -> ExternResult<Rated> {
    match (decode_or::<DeliveryOrder>(latest), decode_or::<PickupOrder>(latest)) {
        (Some(o), _) => Ok(Rated { done: matches!(o.status, DeliveryStatus::Delivered | DeliveryStatus::Collected), disputed: o.status == DeliveryStatus::Disputed, customer: o.requester, merchant: o.merchant, catalog_ref: o.catalog_ref }),
        (None, Some(o)) => Ok(Rated { done: o.status == PickupStatus::PickedUp, disputed: false, customer: o.requester, merchant: o.merchant, catalog_ref: o.catalog_ref }),
        _ => Err(guest("That isn't an order.")),
    }
}

/// Whether `at` is still within the days a customer may be rated after an
/// order completed at `done_at`.
fn rating_open(done_at: Timestamp, at: Timestamp) -> bool {
    at.as_micros() <= done_at.as_micros().saturating_add(i64::from(handshake_governance::customer_rating_days()) * 86_400_000_000)
}

#[derive(Serialize, Debug)]
struct ReportsOnWire {
    customer: AgentPubKey,
    orders: Vec<ActionHash>,
}

/// What the customer reported about each order -- `dispatch::ReportsOn`.
#[derive(Deserialize, Debug, Default, Clone, Copy)]
struct ReportsOn {
    items: bool,
    service: bool,
}

impl ReportsOn {
    /// Whether a report is about this rater: the store, for its items; the
    /// driver, for the delivery.
    fn about(&self, as_store: bool) -> bool {
        match as_store {
            true => self.items,
            false => self.service,
        }
    }
}

fn reports_on(customer: &AgentPubKey, orders: Vec<ActionHash>) -> ExternResult<Vec<ReportsOn>> {
    if orders.is_empty() {
        return Ok(Vec::new());
    }
    call_local::<_, Vec<ReportsOn>>("dispatch", "reports_on", ReportsOnWire { customer: customer.clone(), orders })?.map_err(|why| guest(format!("couldn't read the customer's reports: {why}")))
}

/// The caller -- the order's store or its driver -- rating its customer,
/// once, on the order completed and within days of it -- and not on an
/// order the customer reported them about: that's answered (a store's
/// answer, a finding), not rated.
#[hdk_extern]
pub fn rate_customer(input: RateCustomerInput) -> ExternResult<Record> {
    let order = original_action_of(input.order)?;
    if input.up == input.reason.is_some() {
        return Err(guest("Give a reason for a thumbs-down."));
    }
    if my_rating_on(&order)?.is_some() {
        return Err(guest("You've already rated this customer for this order."));
    }
    // The order as it stands: validation checks it shows the order done.
    let latest = resolve_latest(order.clone())?;
    let terms = order_terms(&latest)?;
    if terms.disputed {
        return Err(guest("This order is disputed, so its customer isn't rated on it."));
    }
    if !terms.done {
        return Err(guest("You can rate the customer once the order's done."));
    }
    if !rating_open(latest.action().timestamp(), sys_time()?) {
        return Err(guest("Customers are rated within a few days of their order, and this one's past that."));
    }
    let me = agent_info()?.agent_initial_pubkey;
    let as_store = me == terms.merchant;
    if reports_on(&terms.customer, vec![order.clone()])?.first().is_some_and(|on| on.about(as_store)) {
        return Err(match as_store {
            true => guest("The customer reported a problem with this order: answer their report rather than rating them."),
            false => guest("The customer reported a problem with this delivery, so you don't rate them on it."),
        });
    }
    let store = as_store.then(|| terms.catalog_ref.clone());
    let rating = CustomerRating { order_ref: order, completed: latest.action_address().clone(), customer: terms.customer.clone(), up: input.up, reason: input.reason, store };
    let hash = create_entry(&EntryTypes::CustomerRating(rating.clone()))?;
    create_link(terms.customer, hash.clone(), LinkTypes::CustomerToRating, customer_rating_tag(&rating))?;
    create_link(me, hash.clone(), LinkTypes::RaterToRating, rater_tag(&rating))?;
    written(hash)
}

/// The caller's rating of an order's customer, if they've given one: up or
/// down, and why.
#[derive(Serialize, Deserialize, Debug)]
pub struct MyCustomerRating {
    pub up: bool,
    pub reason: Option<CustomerReason>,
}

#[hdk_extern]
pub fn my_customer_rating(order: ActionHash) -> ExternResult<Option<MyCustomerRating>> {
    my_rating_on(&original_action_of(order)?)
}

fn my_rating_on(order: &ActionHash) -> ExternResult<Option<MyCustomerRating>> {
    let me = agent_info()?.agent_initial_pubkey;
    let query = LinkQuery::try_new(me.clone(), LinkTypes::RaterToRating)?.author(me).tag_prefix(LinkTag::new(order.get_raw_39().to_vec()));
    Ok(get_links(query, GetStrategy::default())?.into_iter().find_map(|link| {
        let tag = link.tag.0;
        let (&up, &reason) = (tag.get(39)?, tag.get(40)?);
        Some(MyCustomerRating { up: up == 1, reason: (up == 0).then(|| customer_reason(reason)) })
    }))
}

/// A delivery the caller made, for rating its customer.
#[derive(Serialize, Deserialize, Debug)]
pub struct RecentDelivery {
    /// The order's original action.
    pub order: ActionHash,
    pub customer: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub delivered_at: Timestamp,
}

/// The caller's deliveries they can still rate the customer of, newest
/// first, at most `limit` (up to 50): each completion a store recorded for
/// them within `customer_rating_days`, not yet rated, not disputed, and
/// not one its customer reported the delivery of.
#[hdk_extern]
pub fn my_recent_deliveries(limit: u32) -> ExternResult<Vec<RecentDelivery>> {
    let me = agent_info()?.agent_initial_pubkey;
    let window = std::time::Duration::from_secs(u64::from(handshake_governance::customer_rating_days()) * 86_400);
    let mut completions: Vec<Link> = within_each(vec![me.clone().into()], LinkTypes::DriverToEvent, window)?.into_iter().flatten().filter(|link| link.tag.0.first() == Some(&COMPLETED)).collect();
    completions.sort_by_key(|link| std::cmp::Reverse(link.timestamp));
    let rated: BTreeSet<Vec<u8>> = within_each(vec![me.clone().into()], LinkTypes::RaterToRating, window)?.into_iter().flatten().filter(|link| link.author == me).filter_map(|link| link.tag.0.get(..39).map(<[u8]>::to_vec)).collect();
    let now = sys_time()?;
    let most = limit.min(50) as usize;
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for link in completions {
        if out.len() >= most {
            break;
        }
        let Some(order) = link.tag.0.get(9..).and_then(|raw| ActionHash::try_from_raw_39(raw.to_vec()).ok()) else { continue };
        if rated.contains(order.get_raw_39()) || !seen.insert(order.clone()) {
            continue;
        }
        let Ok(latest) = resolve_latest(order.clone()) else { continue };
        let Ok(terms) = order_terms(&latest) else { continue };
        if !terms.done || !rating_open(latest.action().timestamp(), now) {
            continue;
        }
        out.push(RecentDelivery { order, customer: terms.customer, catalog_ref: terms.catalog_ref, delivered_at: latest.action().timestamp() });
    }
    // Not one its customer reported the delivery of: that's answered, not
    // rated. Read a customer at a time, all their orders together.
    let mut reported: BTreeSet<ActionHash> = BTreeSet::new();
    let customers: BTreeSet<AgentPubKey> = out.iter().map(|delivery| delivery.customer.clone()).collect();
    for customer in customers {
        let orders: Vec<ActionHash> = out.iter().filter(|delivery| delivery.customer == customer).map(|delivery| delivery.order.clone()).collect();
        let on = reports_on(&customer, orders.clone())?;
        reported.extend(orders.into_iter().zip(on).filter(|(_, on)| on.about(false)).map(|(order, _)| order));
    }
    Ok(out.into_iter().filter(|delivery| !reported.contains(&delivery.order)).collect())
}

/// A customer's score, as stores and drivers -- and the customer -- read it.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct CustomerScore {
    /// Counted thumbs-up and thumbs-down: the latest word of each of the
    /// customer's last `customer_rating_window` counted raters.
    pub up: u32,
    pub down: u32,
    /// How many thumbs-down gave each reason.
    pub reasons: Vec<(CustomerReason, u32)>,
    /// Whether there are enough to show (`min_customer_ratings`).
    pub shown: bool,
}

/// One rater's latest rating of the customer, from its tag.
struct Word {
    rater: AgentPubKey,
    up: bool,
    reason: u8,
    order: ActionHash,
    /// The store, when its owner rated as the store.
    store: Option<ActionHash>,
}

impl Word {
    fn of(link: &Link) -> Option<Self> {
        let tag = &link.tag.0;
        let order = ActionHash::try_from_raw_39(tag.get(2..41)?.to_vec()).ok()?;
        let store = match tag.get(41..) {
            None | Some([]) => None,
            Some(raw) => Some(ActionHash::try_from_raw_39(raw.to_vec()).ok()?),
        };
        Some(Self { rater: link.author.clone(), up: *tag.first()? == 1, reason: *tag.get(1)?, order, store })
    }
}

/// A customer's score: the latest rating from each rater, newest first,
/// counting only established stores and drivers who don't rate most
/// customers down, and no thumbs-down from whoever a report of the
/// customer's on that order is about -- until the window is full. Raters are judged a window's
/// worth at a time, each a batched read.
#[hdk_extern]
pub fn get_customer_score(customer: AgentPubKey) -> ExternResult<CustomerScore> {
    let target = ReputationTarget::Customer(customer.clone());
    let mut links = recent(bases_of(customer.clone().into(), subject_of(&target))?, LinkTypes::CustomerToRating)?;
    links.sort_by_key(|link| std::cmp::Reverse(link.timestamp));
    let mut raters = BTreeSet::new();
    let words: Vec<Word> = links.iter().filter_map(Word::of).filter(|word| raters.insert(word.rater.clone())).collect();
    let window = handshake_governance::customer_rating_window() as usize;
    let mut score = CustomerScore::default();
    let mut reasons: BTreeMap<u8, u32> = BTreeMap::new();
    // Judged a batch at a time: a window's worth, within what one read of
    // the customer's reports takes.
    for chunk in words.chunks(window.clamp(1, 100)) {
        let counts = counted(chunk)?;
        let downs: Vec<ActionHash> = chunk.iter().filter(|word| !word.up).map(|word| word.order.clone()).collect();
        let reports: BTreeMap<ActionHash, ReportsOn> = downs.iter().cloned().zip(reports_on(&customer, downs.clone())?).collect();
        for (word, counts) in chunk.iter().zip(counts) {
            if (score.up + score.down) as usize >= window {
                break;
            }
            // A thumbs-down from whoever the customer reported on that order
            // is about doesn't count, whichever came first: that's settled by
            // the report, not a rating.
            let answers_report = !word.up && reports.get(&word.order).is_some_and(|on| on.about(word.store.is_some()));
            if !counts || answers_report {
                continue;
            }
            if word.up {
                score.up += 1;
            } else {
                score.down += 1;
                *reasons.entry(word.reason).or_default() += 1;
            }
        }
        if (score.up + score.down) as usize >= window {
            break;
        }
    }
    score.reasons = reasons.into_iter().map(|(index, count)| (customer_reason(index), count)).collect();
    score.shown = score.up + score.down >= handshake_governance::min_customer_ratings();
    Ok(score)
}

/// Whether each rater's word counts, over the rater window: an established
/// store (enough completed orders from enough different customers) or
/// driver (deliveries recorded by enough different stores) -- so a store or
/// account made to rate doesn't -- who, having rated enough customers,
/// doesn't rate more of them down than the network allows. Each check reads
/// the shortest window that settles it (`settled_each`), batched across the
/// raters, so a busy rater costs a day of links, not months of them.
fn counted(words: &[Word]) -> ExternResult<Vec<bool>> {
    let window = handshake_governance::rater_window();
    let fair = settled_each(words.iter().map(|word| word.rater.clone().into()).collect(), LinkTypes::RaterToRating, window, &|at, links| rates_fairly(&words[at].rater, links, FAIRNESS_SAMPLE), &|at, links| rates_fairly(&words[at].rater, links, 0).unwrap_or(true))?;
    let stores: Vec<(ActionHash, AgentPubKey)> = words.iter().filter_map(|word| word.store.clone().map(|store| (store, word.rater.clone()))).collect();
    let drivers: Vec<AnyLinkableHash> = words.iter().filter(|word| word.store.is_none()).map(|word| word.rater.clone().into()).collect();
    let mut stores_ok = crate::findings::stores_established(stores, window)?.into_iter();
    let mut drivers_ok = delivered_for_enough(drivers, window)?.into_iter();
    Ok(words.iter().zip(fair).map(|(word, fair)| {
        let established = match word.store {
            Some(_) => stores_ok.next().unwrap_or(false),
            None => drivers_ok.next().unwrap_or(false),
        };
        established && fair
    }).collect())
}

/// How many of a rater's latest ratings judge their fairness, at least: a
/// day of ratings can't wash out the months before it.
const FAIRNESS_SAMPLE: u32 = 50;

/// Whether a rater's ratings count, once `links` hold at least `sample` of
/// theirs and `min_rater_ratings`: not one who rates more of the customers
/// they rated down than the network allows. Too few to judge: `None`.
fn rates_fairly(rater: &AgentPubKey, links: &[Link], sample: u32) -> Option<bool> {
    let mine: Vec<&Link> = links.iter().filter(|link| &link.author == rater).collect();
    let total = mine.len() as u32;
    if total < handshake_governance::min_rater_ratings().max(sample) {
        return None;
    }
    let down = mine.iter().filter(|link| link.tag.0.get(39) == Some(&0)).count() as u32;
    Some(down * 100 <= total * u32::from(handshake_governance::max_rater_down_percent()))
}

fn customer_reason(index: u8) -> CustomerReason {
    [CustomerReason::RudeOrAbusive, CustomerReason::Unreachable, CustomerReason::Unsafe, CustomerReason::AddressDetails, CustomerReason::OffApp, CustomerReason::Other].get(usize::from(index)).copied().unwrap_or(CustomerReason::Other)
}

// --- blocks ---

#[derive(Serialize, Deserialize, Debug)]
pub struct BlockInput {
    /// The caller, as themselves or as a store they own.
    pub by: Party,
    pub blocked: Party,
}

/// The caller blocking a party, as themselves or as their store: the two no
/// longer see or deal with each other. A store's block joins its listing at
/// once; everyone's joins the orders placed or accepted after it.
#[hdk_extern]
pub fn block(input: BlockInput) -> ExternResult<()> {
    if input.by == input.blocked {
        return Err(guest("You can't block yourself."));
    }
    if !speaks_for(&input.by, &agent_info()?.agent_initial_pubkey)? {
        return Err(guest("You can block only as yourself, or as a store you own."));
    }
    let mut book = Book::mine()?;
    let current = book.list(&input.by);
    if current.contains(&input.blocked) {
        return Ok(());
    }
    // Newest first: once a list is full, it's the oldest that drop off it.
    let blocked: Vec<Party> = std::iter::once(input.blocked).chain(current).take(handshake_types::block_prints::most_real()).collect();
    book.set(&input.by, blocked.clone());
    book.write()?;
    publish_store_list(&input.by, &blocked)
}

/// The caller lifting a block they made.
#[hdk_extern]
pub fn unblock(input: BlockInput) -> ExternResult<()> {
    let mut book = Book::mine()?;
    let current = book.list(&input.by);
    if !current.contains(&input.blocked) {
        return Ok(());
    }
    let blocked: Vec<Party> = current.into_iter().filter(|party| party != &input.blocked).collect();
    book.set(&input.by, blocked.clone());
    book.write()?;
    publish_store_list(&input.by, &blocked)
}

#[derive(Serialize, Debug)]
struct SetBlockedPeopleWire {
    original_action: ActionHash,
    people: Vec<AgentPubKey>,
}

/// A store's blocks, rewritten into its listing so the people it blocked
/// don't see it; a person's blocks stay in their own sealed list.
fn publish_store_list(by: &Party, blocked: &[Party]) -> ExternResult<()> {
    let Party::Store(catalog) = by else { return Ok(()) };
    let people: Vec<AgentPubKey> = blocked.iter().filter_map(|party| match party {
        Party::Person(agent) => Some(agent.clone()),
        Party::Store(_) => None,
    }).collect();
    call_local::<_, Record>("catalog", "set_blocked_people", SetBlockedPeopleWire { original_action: catalog.clone(), people })?.map_err(|why| guest(format!("couldn't update your store's listing: {why}")))?;
    Ok(())
}

/// Whom the caller has blocked as `by` (themselves, or a store of theirs),
/// most recent first, from their own sealed list.
#[hdk_extern]
pub fn my_blocks(by: Party) -> ExternResult<Vec<Party>> {
    Ok(Book::mine()?.list(&by))
}

/// An account's blocks as it keeps them (`SealedBlocks`, opened): each
/// party it blocks as, with whom, most recent first.
#[derive(Serialize, Deserialize, Debug, Default)]
struct BookContents {
    lists: Vec<(Party, Vec<Party>)>,
}

/// The caller's own list of blocks, opened, and where it's kept.
struct Book {
    /// Its first version, when it's been written.
    original: Option<ActionHash>,
    contents: BookContents,
}

impl Book {
    /// The caller's list -- empty if they've never blocked anyone, or if it
    /// was sealed to a key they no longer hold (a recovered account starts
    /// afresh, as its old key is gone).
    fn mine() -> ExternResult<Self> {
        let me = agent_info()?.agent_initial_pubkey;
        let mut links = get_links(LinkQuery::try_new(me.clone(), LinkTypes::OwnerToBlocks)?.author(me.clone()), GetStrategy::default())?;
        links.sort_by_key(|link| link.timestamp);
        let Some(original) = links.into_iter().find_map(|link| link.target.into_action_hash()) else {
            return Ok(Self { original: None, contents: BookContents::default() });
        };
        let record = resolve_latest(original.clone())?;
        let contents = decode_or::<SealedBlocks>(&record).map(|sealed| handshake_coordinator_support::open_chunked_padded::<BookContents>(&me, &sealed.sealed)).transpose()?.flatten().unwrap_or_default();
        Ok(Self { original: Some(original), contents })
    }

    fn list(&self, by: &Party) -> Vec<Party> {
        self.contents.lists.iter().find(|(party, _)| party == by).map(|(_, blocked)| blocked.clone()).unwrap_or_default()
    }

    fn set(&mut self, by: &Party, blocked: Vec<Party>) {
        self.contents.lists.retain(|(party, _)| party != by);
        if !blocked.is_empty() {
            self.contents.lists.push((by.clone(), blocked));
        }
    }

    /// Seals the list to the caller, padded to whole boxes, as a new
    /// version of the one they keep.
    fn write(self) -> ExternResult<()> {
        let me = agent_info()?.agent_initial_pubkey;
        if ExternIO::encode(&self.contents).map_err(|e| wasm_error!(e))?.0.len() > MAX_BLOCK_BOOK_BYTES - SEAL_PAD_ROOM {
            return Err(guest("You've blocked as many as the app keeps. Unblock someone first."));
        }
        let entry = SealedBlocks { sealed: handshake_coordinator_support::seal_chunked_padded(&me, &self.contents)? };
        match self.original {
            Some(original) => {
                let current = handshake_coordinator_support::resolve_version(original)?;
                handshake_coordinator_support::update_version(&current, &EntryTypes::SealedBlocks(entry), LinkTypes::Version)?;
            }
            None => {
                let hash = create_entry(&EntryTypes::SealedBlocks(entry))?;
                create_link(me, hash, LinkTypes::OwnerToBlocks, ())?;
            }
        }
        Ok(())
    }
}

/// What padding to whole boxes may add to a list.
const SEAL_PAD_ROOM: usize = 4_096;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_read_back_from_their_tag() {
        for reason in [CustomerReason::RudeOrAbusive, CustomerReason::Unreachable, CustomerReason::Unsafe, CustomerReason::AddressDetails, CustomerReason::OffApp, CustomerReason::Other] {
            assert_eq!(customer_reason(reason as u8), reason);
        }
        assert_eq!(customer_reason(200), CustomerReason::Other);
    }
}
