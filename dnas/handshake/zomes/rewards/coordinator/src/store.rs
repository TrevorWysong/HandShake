//! The store's side: each member's orders, linked publicly from the member
//! as the store accepts them (`MemberToOrder`), each member's points carried
//! forward in the store's account of them (`accounts`), and whether those
//! points cover the reward an order spends.
//!
//! Everything a member's points rest on is public -- the store's links to
//! its acceptances, its settlements, its grants -- so the store's account of
//! them is only ever a cache: a device that restores its chain, or a store
//! recovered by its owner's new key, plays it all again from what the
//! network holds.

use super::*;
use rewards_integrity::ledger::{Folded, OpenGrant, OpenOrder};

/// The store `catalog_ref`'s links from `customer` to its acceptances of
/// their orders, written by `owner` -- all of them, or one order's.
pub(crate) fn member_order_links(customer: &AgentPubKey, catalog_ref: &ActionHash, owner: &AgentPubKey, order: Option<&ActionHash>) -> ExternResult<Vec<Link>> {
    let prefix = match order {
        Some(order) => member_order_tag(catalog_ref, order),
        None => catalog_ref.get_raw_39().to_vec(),
    };
    let query = LinkQuery::try_new(customer.clone(), LinkTypes::MemberToOrder)?.author(owner.clone()).tag_prefix(LinkTag::new(prefix));
    // Each link's author checked too, not left to the query's filter alone.
    Ok(get_links(query, GetStrategy::default())?.into_iter().filter(|link| &link.author == owner).collect())
}

/// The stores whose members' points `catalog_ref` carries on: itself, then
/// each store it was moved on from by its owner's new key, newest first
/// (catalog's `store_line`).
pub(crate) fn store_line(catalog_ref: &ActionHash) -> ExternResult<Vec<ActionHash>> {
    let earlier: Vec<ActionHash> = call_local("catalog", "store_line", catalog_ref.clone())?.map_err(|why| guest(format!("store_line: {why}")))?;
    Ok(std::iter::once(catalog_ref.clone()).chain(earlier).collect())
}

/// Every order of `customer`'s the stores in `catalog_ref`'s line accepted
/// under their programs -- however many: read from each store's links,
/// one read per store, not from anyone's chain.
pub(crate) fn member_orders(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Vec<OpenOrder>> {
    let mut out: Vec<OpenOrder> = Vec::new();
    for catalog in store_line(catalog_ref)? {
        let owner = store(&catalog)?.owner;
        for link in member_order_links(customer, &catalog, &owner, None)? {
            let Some((_, order)) = parse_member_order_tag(&link.tag.0) else { continue };
            let Some(accepted) = link.target.into_action_hash() else { continue };
            if out.iter().any(|o| o.order == order) {
                continue;
            }
            // Validated as an acceptance of this order: one not here yet
            // would leave a spend out, and the points it spent unspent.
            let placed = arrived(&order)?;
            let reward = OrderForRewards::of(&placed).and_then(|o| o.rewards).and_then(|r| r.reward);
            out.push(OpenOrder { order, placed_at: placed.action().timestamp(), accepted: Some(accepted), reward, settled: None });
        }
    }
    Ok(out)
}

/// Every grant of the caller's store to `customer`, opened, with when it
/// was given -- from the links it leaves the member, not its chain. Only
/// the caller's own: a grant sealed by a store's earlier key can't be
/// opened by its new one (docs/REWARDS.md, "When a store moves").
pub(crate) fn my_grant_payloads_to(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Vec<(ActionHash, Timestamp, GrantPayload)>> {
    let me = me()?;
    let query = LinkQuery::try_new(customer.clone(), LinkTypes::AgentToGrant)?.author(me.clone());
    let mut out = Vec::new();
    for link in get_links(query, GetStrategy::default())?.into_iter().filter(|link| link.author == me) {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let record = arrived(&hash)?;
        let Some(grant) = decode_or::<PointsGrant>(&record).filter(|g| &g.to == customer && &g.catalog_ref == catalog_ref && record.action().author() == &me) else { continue };
        if let Some(payload) = open::<GrantPayload>(customer, &grant.sealed)? {
            out.push((record.action_address().clone(), record.action().timestamp(), payload));
        }
    }
    Ok(out)
}

/// Every grant of the caller's store to `customer`, as a ledger plays it.
pub(crate) fn my_grants_to(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Vec<OpenGrant>> {
    Ok(my_grant_payloads_to(catalog_ref, customer)?.into_iter().map(|(grant, at, payload)| open_grant(grant, at, &payload)).collect())
}

/// The caller's store's own program, current -- found by the store's link
/// to it, not by walking back to where the store first wrote it.
pub(crate) fn my_running_program(catalog_ref: &ActionHash) -> ExternResult<ProgramView> {
    program_of(catalog_ref.clone())?.ok_or(guest("This store has no rewards program."))
}

/// `customer`'s points as the caller's store has them now: their account
/// carried forward, with `also` (an order just accepted, a grant just
/// given) played in -- or played afresh from the public records when it
/// must be. The account found, and the fold.
pub(crate) fn store_standing(catalog_ref: &ActionHash, customer: &AgentPubKey, program: &ProgramView, also_orders: Vec<OpenOrder>, also_grants: Vec<OpenGrant>) -> ExternResult<(accounts::Kept<MemberAccount>, Folded)> {
    let now = sys_time()?;
    let found = account(catalog_ref, customer, true)?;
    let prior = found.value.as_ref().and_then(|a| a.ledger.as_ref()).filter(|l| l.program == program.version);
    // Gifts an earlier key of the store gave, that the member has shown.
    let earlier = carried::earlier_gifts(catalog_ref, customer)?;
    if let Some(ledger) = prior {
        let orders: Vec<OpenOrder> = ledger.open_orders.iter().cloned().chain(also_orders.iter().cloned()).collect();
        let shown = earlier.iter().filter(|g| !ledger.folded_grants.contains(&g.grant)).cloned();
        let grants = unique_grants(ledger.open_grants.iter().cloned().chain(also_grants.iter().cloned()).chain(shown));
        if let Ok((folded, _)) = play(program, Some(ledger), &orders, grants, false, now)? {
            return Ok((found, folded));
        }
    }
    // Afresh, from the public records -- with what this call has just
    // recorded, should the network not show it yet.
    let orders: Vec<OpenOrder> = member_orders(catalog_ref, customer)?.into_iter().chain(also_orders).collect();
    let grants = unique_grants(my_grants_to(catalog_ref, customer)?.into_iter().chain(also_grants).chain(earlier));
    let (folded, _) = play(program, None, &orders, grants, false, now)?.map_err(|_| guest("couldn't play this member's history"))?;
    Ok((found, folded))
}

/// `grants`, each once.
fn unique_grants(grants: impl Iterator<Item = OpenGrant>) -> Vec<OpenGrant> {
    let mut out: Vec<OpenGrant> = Vec::new();
    for grant in grants {
        if !out.iter().any(|g| g.grant == grant.grant) {
            out.push(grant);
        }
    }
    out
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RedeemCheck {
    pub customer: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// The program version the order cites.
    pub program: ActionHash,
    pub reward: u16,
}

/// The store's check before accepting an order that spends a reward: the
/// customer's points, worked out from the store's own records, cover it at
/// the tier it needs. Errs with why not. Writes nothing: it runs as the
/// store accepts, and the acceptance itself carries the account forward.
#[hdk_extern]
pub fn can_redeem(input: RedeemCheck) -> ExternResult<()> {
    let store_info = store(&input.catalog_ref)?;
    if store_info.owner != me()? {
        return Err(guest("not this store's owner"));
    }
    let program = my_running_program(&input.catalog_ref)?;
    let Ok(cited) = program_at(&input.program, &input.catalog_ref)? else { return Err(guest("This order's reward isn't one of your program's.")) };
    let reward = cited.reward(input.reward).ok_or(guest("This order's reward isn't one of your program's."))?;
    let (_, folded) = store_standing(&input.catalog_ref, &input.customer, &program, Vec::new(), Vec::new())?;
    let event = Event::Spend { at: sys_time()?, cost: u64::from(reward.cost), min_tier: reward.min_tier };
    step(&program.program, folded.state.as_ref(), event).map(|_| ()).map_err(|reason| {
        if reason == "that reward needs a higher tier" {
            guest("This customer's tier doesn't reach that reward, so this order can't be accepted -- decline it.")
        } else {
            guest("This customer's points don't cover that reward, so this order can't be accepted -- decline it.")
        }
    })
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MemberOrderInput {
    /// The order's original action.
    pub order: ActionHash,
    /// The caller's acceptance of it.
    pub accepted: ActionHash,
}

/// Records an order the caller's store accepted that joined its program --
/// linked publicly from the member, what their points are worked out from --
/// lists the member, and carries their account forward, in the same call.
/// Safe to repeat: the order's link is found by its exact tag.
#[hdk_extern]
pub fn record_member_order(input: MemberOrderInput) -> ExternResult<()> {
    let Some(record) = get(input.order.clone(), GetOptions::default())? else { return Ok(()) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(()) };
    let Some(rewards) = placed.rewards.clone() else { return Ok(()) };
    let me = me()?;
    if placed.merchant != me {
        return Ok(());
    }
    if !member_order_links(&placed.requester, &placed.catalog_ref, &me, Some(&input.order))?.is_empty() {
        return Ok(());
    }
    create_link(placed.requester.clone(), input.accepted.clone(), LinkTypes::MemberToOrder, LinkTag::new(member_order_tag(&placed.catalog_ref, &input.order)))?;
    list_member(&placed.catalog_ref, &placed.requester)?;
    let program = my_running_program(&placed.catalog_ref)?;
    let order = OpenOrder { order: input.order.clone(), placed_at: record.action().timestamp(), accepted: Some(input.accepted), reward: rewards.reward, settled: None };
    // Their points at the store's earlier self on the network before, if it
    // was brought over: carried on their first order here, and again
    // whenever they've shown it more of their gifts from there.
    let carried_at = account(&placed.catalog_ref, &placed.requester, true)?.value.and_then(|a| a.carried_at);
    let shown = carried::reveals_shown(&placed.catalog_ref, &placed.requester)?;
    let carried = if carried_at.is_some_and(|at| at >= shown) { Ok(None) } else { carried::carry_previous_points(&placed.catalog_ref, &placed.requester, &input.order) };
    let also_grants: Vec<OpenGrant> = carried.as_ref().ok().cloned().flatten().into_iter().collect();
    let (found, folded) = store_standing(&placed.catalog_ref, &placed.requester, &program, vec![order], also_grants)?;
    // A carry that couldn't reach the network before is tried again next time.
    let carried_at = if carried.is_ok() { Some(shown) } else { carried_at };
    keep(&found, MemberAccount { catalog_ref: placed.catalog_ref, member: placed.requester, kept_by_store: true, ledger: Some(folded.ledger), latest_order: Some(input.order), carried_at })
}

/// Puts `member` on the caller's store's list of members, once.
fn list_member(catalog_ref: &ActionHash, member: &AgentPubKey) -> ExternResult<()> {
    if store_members_where(catalog_ref, Some(member))?.is_empty() {
        create_link(catalog_ref.clone(), member.clone(), LinkTypes::StoreToMember, LinkTag::new(member.get_raw_39().to_vec()))?;
    }
    Ok(())
}

/// The members on the store's list, each with when they joined it -- or just
/// `member`, if they're on it. Only the store's owner's list counts.
pub(crate) fn store_members_where(catalog_ref: &ActionHash, member: Option<&AgentPubKey>) -> ExternResult<Vec<(AgentPubKey, Timestamp)>> {
    let owner = store(catalog_ref)?.owner;
    let mut query = LinkQuery::try_new(catalog_ref.clone(), LinkTypes::StoreToMember)?.author(owner.clone());
    if let Some(member) = member {
        query = query.tag_prefix(LinkTag::new(member.get_raw_39().to_vec()));
    }
    let mut members: Vec<(AgentPubKey, Timestamp)> = Vec::new();
    for link in get_links(query, GetStrategy::default())?.into_iter().filter(|link| link.author == owner) {
        let Some(who) = link.target.into_agent_pub_key() else { continue };
        match members.iter_mut().find(|(m, _)| m == &who) {
            Some((_, joined)) => *joined = (*joined).min(link.timestamp),
            None => members.push((who, link.timestamp)),
        }
    }
    Ok(members)
}

/// The members of the store `catalog_ref`, by when they joined, oldest first.
pub(crate) fn store_members(catalog_ref: &ActionHash) -> ExternResult<Vec<(AgentPubKey, Timestamp)>> {
    let mut members = store_members_where(catalog_ref, None)?;
    members.sort_by_key(|(_, joined)| *joined);
    Ok(members)
}

/// Carries a member's account forward with a grant the caller's store just
/// gave them, in the same call.
pub(crate) fn record_grant(catalog_ref: &ActionHash, to: &AgentPubKey, grant: OpenGrant) -> ExternResult<()> {
    let Some(program) = program_of(catalog_ref.clone())? else { return Ok(()) };
    let (found, folded) = store_standing(catalog_ref, to, &program, Vec::new(), vec![grant])?;
    let (latest_order, carried_at) = found.value.as_ref().map_or((None, None), |a| (a.latest_order.clone(), a.carried_at));
    keep(&found, MemberAccount { catalog_ref: catalog_ref.clone(), member: to.clone(), kept_by_store: true, ledger: Some(folded.ledger), latest_order, carried_at })
}
