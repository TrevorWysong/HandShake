//! Phase 4 (docs/REPUTATION.md): customers rated by the stores and drivers
//! who served them, and blocks between any two parties. A customer's score
//! is the share of thumbs-up over their recent rated orders, from raters who
//! don't rate most customers down, shown once there are enough; a block
//! hides a pair from each other, whichever made it.

use super::*;
use handshake_coordinator_support::chain::mine;

// --- rating customers ---

#[derive(Serialize, Deserialize, Debug)]
pub struct RateCustomerInput {
    /// The order's original action.
    pub order: ActionHash,
    pub up: bool,
    /// Why, for a thumbs-down.
    pub reason: Option<CustomerReason>,
}

#[derive(Deserialize, Debug)]
struct OrderPartiesWire {
    customer: AgentPubKey,
}

/// The caller -- the order's store or its driver -- rating its customer,
/// once, on the order completed.
#[hdk_extern]
pub fn rate_customer(input: RateCustomerInput) -> ExternResult<Record> {
    let order = original_action_of(input.order)?;
    if input.up == input.reason.is_some() {
        return Err(guest("Give a reason for a thumbs-down."));
    }
    if my_rating_on(&order)?.is_some() {
        return Err(guest("You've already rated this customer for this order."));
    }
    let parties: OrderPartiesWire = call_local::<_, OrderPartiesWire>("dispatch", "get_issue_items", order.clone())?.map_err(|why| guest(format!("get_issue_items: {why}")))?;
    // The order as it stands: validation checks it shows the order done.
    let completed = resolve_latest(order.clone())?.action_address().clone();
    let rating = CustomerRating { order_ref: order, completed, customer: parties.customer.clone(), up: input.up, reason: input.reason };
    let hash = create_entry(&EntryTypes::CustomerRating(rating.clone()))?;
    create_link(parties.customer, hash.clone(), LinkTypes::CustomerToRating, customer_rating_tag(&rating))?;
    create_link(agent_info()?.agent_initial_pubkey, hash.clone(), LinkTypes::RaterToRating, rater_tag(&rating))?;
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

/// A customer's score, as stores and drivers -- and the customer -- read it.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct CustomerScore {
    /// Counted thumbs-up and thumbs-down, over the customer's last
    /// `customer_rating_window` counted ratings.
    pub up: u32,
    pub down: u32,
    /// How many thumbs-down gave each reason.
    pub reasons: Vec<(CustomerReason, u32)>,
    /// Whether there are enough to show (`min_customer_ratings`).
    pub shown: bool,
}

/// A customer's score: newest ratings first, one per rater per order, from
/// raters who don't rate most customers down, until the window is full.
#[hdk_extern]
pub fn get_customer_score(customer: AgentPubKey) -> ExternResult<CustomerScore> {
    let target = ReputationTarget::Customer(customer.clone());
    let mut links = recent(bases_of(customer.into(), subject_of(&target))?, LinkTypes::CustomerToRating)?;
    links.sort_by_key(|link| std::cmp::Reverse(link.timestamp));
    let window = handshake_governance::customer_rating_window();
    let mut seen: Vec<(AgentPubKey, Vec<u8>)> = Vec::new();
    let mut fair: BTreeMap<AgentPubKey, bool> = BTreeMap::new();
    let mut score = CustomerScore::default();
    let mut reasons: BTreeMap<u8, u32> = BTreeMap::new();
    for link in links {
        if score.up + score.down >= window {
            break;
        }
        let tag = link.tag.0.clone();
        let (Some(&up), Some(&reason), Some(order)) = (tag.first(), tag.get(1), tag.get(2..)) else { continue };
        let key = (link.author.clone(), order.to_vec());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let counts = match fair.get(&link.author) {
            Some(known) => *known,
            None => {
                let known = rates_fairly(&link.author)?;
                fair.insert(link.author.clone(), known);
                known
            }
        };
        if !counts {
            continue;
        }
        if up == 1 {
            score.up += 1;
        } else {
            score.down += 1;
            *reasons.entry(reason).or_default() += 1;
        }
    }
    score.reasons = reasons.into_iter().map(|(index, count)| (customer_reason(index), count)).collect();
    score.shown = score.up + score.down >= handshake_governance::min_customer_ratings();
    Ok(score)
}

/// Whether a rater's ratings count: not one who, having rated enough
/// customers, rates more of them down than the network allows.
fn rates_fairly(rater: &AgentPubKey) -> ExternResult<bool> {
    let links = recent(vec![rater.clone().into()], LinkTypes::RaterToRating)?;
    let mine: Vec<&Link> = links.iter().filter(|link| &link.author == rater).collect();
    let total = mine.len() as u32;
    if total < handshake_governance::min_rater_ratings() {
        return Ok(true);
    }
    let down = mine.iter().filter(|link| link.tag.0.get(39) == Some(&0)).count() as u32;
    Ok(down * 100 <= total * u32::from(handshake_governance::max_rater_down_percent()))
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
/// longer see or deal with each other.
#[hdk_extern]
pub fn block(input: BlockInput) -> ExternResult<()> {
    if input.by == input.blocked {
        return Err(guest("You can't block yourself."));
    }
    // Blocked already: nothing more to do.
    if !my_block_links(&input.by, &input.blocked)?.is_empty() {
        return Ok(());
    }
    create_link(pair_key(&input.by, &input.blocked)?, input.blocked.as_target(), LinkTypes::PairToBlock, block_tag(&input.by, &input.blocked)?)?;
    create_entry(&EntryTypes::PartyBlock(PartyBlock { by: input.by, blocked: input.blocked, on: true }))?;
    Ok(())
}

/// The caller lifting a block they made.
#[hdk_extern]
pub fn unblock(input: BlockInput) -> ExternResult<()> {
    for link in my_block_links(&input.by, &input.blocked)? {
        delete_link(link.create_link_hash, GetOptions::default())?;
    }
    create_entry(&EntryTypes::PartyBlock(PartyBlock { by: input.by, blocked: input.blocked, on: false }))?;
    Ok(())
}

/// The caller's own links blocking `blocked` as `by`.
fn my_block_links(by: &Party, blocked: &Party) -> ExternResult<Vec<Link>> {
    let tag = block_tag(by, blocked)?;
    let query = LinkQuery::try_new(pair_key(by, blocked)?, LinkTypes::PairToBlock)?.author(agent_info()?.agent_initial_pubkey);
    Ok(get_links(query, GetStrategy::default())?.into_iter().filter(|link| link.tag == tag).collect())
}

/// Whom the caller has blocked as `by` (themselves, or a store of theirs),
/// from their own private list: each party's latest word.
#[hdk_extern]
pub fn my_blocks(by: Party) -> ExternResult<Vec<Party>> {
    let mut latest: Vec<(Party, bool)> = Vec::new();
    for record in mine(&[UnitEntryTypes::PartyBlock.try_into()?]).records()? {
        let Some(block) = decode_or::<PartyBlock>(&record).filter(|b| b.by == by) else { continue };
        // Newest first: the first word on a party is its latest.
        if !latest.iter().any(|(party, _)| party == &block.blocked) {
            latest.push((block.blocked, block.on));
        }
    }
    Ok(latest.into_iter().filter(|(_, on)| *on).map(|(party, _)| party).collect())
}

/// Whether each pair is blocked, either way -- read together, one query per
/// pair, for a page of stores or bids at once.
#[hdk_extern]
pub fn blocked_pairs(pairs: Vec<(Party, Party)>) -> ExternResult<Vec<bool>> {
    let queries = pairs.iter().map(|(a, b)| LinkQuery::try_new(pair_key(a, b)?, LinkTypes::PairToBlock)).collect::<ExternResult<Vec<_>>>()?;
    Ok(get_links_many(queries)?.into_iter().map(|links| !links.is_empty()).collect())
}

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
