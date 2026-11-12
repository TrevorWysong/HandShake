//! The store's side: its members' orders, kept privately as it accepts
//! them, each member's points carried forward in the store's account of
//! them (`accounts`), and whether those points cover the reward an order
//! spends.

use super::*;
use rewards_integrity::ledger::{Folded, OpenGrant, OpenOrder};

/// Every order of `customer`'s the caller's store recorded under its
/// program -- however many. A walk of the store's whole chain: only for
/// playing an account afresh.
pub(crate) fn member_orders(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Vec<OpenOrder>> {
    let types = [EntryType::try_from(UnitEntryTypes::MemberOrder)?];
    let mut out = Vec::new();
    for record in mine(&types).records()? {
        let Some(m) = decode_or::<MemberOrder>(&record).filter(|m| &m.customer == customer && &m.catalog_ref == catalog_ref) else { continue };
        let Some(placed) = get(m.order.clone(), GetOptions::default())? else { continue };
        out.push(OpenOrder { order: m.order, placed_at: placed.action().timestamp(), accepted: Some(m.accepted), reward: m.reward.map(|(id, ..)| id), settled: None });
    }
    Ok(out)
}

/// Every grant of the caller's store to `customer`, opened, with when it
/// was given -- however many. A walk of the store's whole chain.
pub(crate) fn my_grant_payloads_to(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Vec<(ActionHash, Timestamp, GrantPayload)>> {
    let types = [EntryType::try_from(UnitEntryTypes::PointsGrant)?];
    let mut out = Vec::new();
    for record in mine(&types).records()? {
        let Some(grant) = decode_or::<PointsGrant>(&record).filter(|g| &g.to == customer && &g.catalog_ref == catalog_ref) else { continue };
        if let Some(payload) = open::<GrantPayload>(customer, &grant.sealed)? {
            out.push((record.action_address().clone(), record.action().timestamp(), payload));
        }
    }
    Ok(out)
}

/// Every grant of the caller's store to `customer`, as a ledger plays it:
/// only for playing an account afresh.
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
/// given) played in -- or played afresh from everything when it must be.
/// The account found, the fold, and whether it was played afresh.
pub(crate) fn store_standing(catalog_ref: &ActionHash, customer: &AgentPubKey, program: &ProgramView, also_orders: Vec<OpenOrder>, also_grants: Vec<OpenGrant>) -> ExternResult<(accounts::Kept<MemberAccount>, Folded)> {
    let now = sys_time()?;
    let found = account(catalog_ref, customer, true)?;
    let prior = found.value.as_ref().and_then(|a| a.ledger.as_ref()).filter(|l| l.program == program.version);
    if let Some(ledger) = prior {
        let orders: Vec<OpenOrder> = ledger.open_orders.iter().cloned().chain(also_orders).collect();
        let grants: Vec<OpenGrant> = ledger.open_grants.iter().cloned().chain(also_grants).collect();
        if let Ok((folded, _)) = play(program, Some(ledger), &orders, grants, None, now)? {
            return Ok((found, folded));
        }
    }
    // Afresh: what the store's chain holds already has what this call wrote.
    let (folded, _) = play(program, None, &member_orders(catalog_ref, customer)?, my_grants_to(catalog_ref, customer)?, None, now)?.map_err(|_| guest("couldn't play this member's history"))?;
    Ok((found, folded))
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

/// Records, privately, an order the caller's store accepted that joined its
/// program -- what its members' points are worked out from -- and carries
/// the member's account forward with it, in the same call. Safe to repeat:
/// the record is the same each time, so it's found by its own hash.
#[hdk_extern]
pub fn record_member_order(input: MemberOrderInput) -> ExternResult<()> {
    let Some(record) = get(input.order.clone(), GetOptions::default())? else { return Ok(()) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(()) };
    let Some(rewards) = placed.rewards.clone() else { return Ok(()) };
    let me = me()?;
    if placed.merchant != me {
        return Ok(());
    }
    let reward = match rewards.reward {
        Some(id) => program_at(&rewards.program, &placed.catalog_ref)?.ok().and_then(|p| p.reward(id).map(|r| (id, r.cost, r.min_tier))),
        None => None,
    };
    let member_order = EntryTypes::MemberOrder(MemberOrder { catalog_ref: placed.catalog_ref.clone(), customer: placed.requester.clone(), order: input.order.clone(), accepted: input.accepted.clone(), reward });
    let recorded = matches!(get_details(hash_entry(&member_order)?, GetOptions::local())?, Some(Details::Entry(e)) if e.actions.iter().any(|a| a.action().author() == &me));
    if recorded {
        return Ok(());
    }
    create_entry(&member_order)?;
    let program = my_running_program(&placed.catalog_ref)?;
    let order = OpenOrder { order: input.order.clone(), placed_at: record.action().timestamp(), accepted: Some(input.accepted), reward: rewards.reward, settled: None };
    let (found, folded) = store_standing(&placed.catalog_ref, &placed.requester, &program, vec![order], Vec::new())?;
    keep(&found, MemberAccount { catalog_ref: placed.catalog_ref, member: placed.requester, kept_by_store: true, ledger: Some(folded.ledger), latest_order: Some(input.order) })
}

/// Carries a member's account forward with a grant the caller's store just
/// gave them, in the same call.
pub(crate) fn record_grant(catalog_ref: &ActionHash, to: &AgentPubKey, grant: OpenGrant) -> ExternResult<()> {
    let Some(program) = program_of(catalog_ref.clone())? else { return Ok(()) };
    let (found, folded) = store_standing(catalog_ref, to, &program, Vec::new(), vec![grant])?;
    let latest_order = found.value.as_ref().and_then(|a| a.latest_order.clone());
    keep(&found, MemberAccount { catalog_ref: catalog_ref.clone(), member: to.clone(), kept_by_store: true, ledger: Some(folded.ledger), latest_order })
}
