//! The store's side: its members' orders, kept privately as it accepts
//! them, and whether a member's points cover the reward an order spends.

use super::*;

/// The store's own record of the orders a member placed under its program.
pub(crate) fn member_orders(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Vec<MemberOrderView>> {
    let types = [EntryType::try_from(UnitEntryTypes::MemberOrder)?];
    let mut out = Vec::new();
    for record in mine(&types).records()? {
        let Some(m) = decode_or::<MemberOrder>(&record).filter(|m| &m.customer == customer && &m.catalog_ref == catalog_ref) else { continue };
        let Some(placed) = get(m.order.clone(), GetOptions::default())? else { continue };
        out.push(MemberOrderView { order: m.order, placed_at: placed.action().timestamp(), accepted: Some(m.accepted), reward: m.reward.map(|(id, ..)| id) });
    }
    Ok(out)
}

/// The caller's store's own grants to `customer`, opened.
pub(crate) fn my_grants_to(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Vec<(ActionHash, Timestamp, GrantPayload)>> {
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

/// The caller's store's own program, current, and the store.
pub(crate) fn my_running_program(catalog_ref: &ActionHash) -> ExternResult<RewardsProgram> {
    let current = my_program(catalog_ref)?.ok_or(guest("This store has no rewards program."))?;
    decode_or::<RewardsProgram>(&current.record).ok_or(guest("that isn't a program"))
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
/// the tier it needs. Errs with why not.
#[hdk_extern]
pub fn can_redeem(input: RedeemCheck) -> ExternResult<()> {
    let store_info = store(&input.catalog_ref)?;
    if store_info.owner != me()? {
        return Err(guest("not this store's owner"));
    }
    let program = my_running_program(&input.catalog_ref)?;
    let Ok(cited) = program_at(&input.program, &input.catalog_ref)? else { return Err(guest("This order's reward isn't one of your program's.")) };
    let reward = cited.reward(input.reward).ok_or(guest("This order's reward isn't one of your program's."))?;
    let orders = member_orders(&input.catalog_ref, &input.customer)?;
    let grants = my_grants_to(&input.catalog_ref, &input.customer)?.into_iter().map(|(grant, at, g)| (grant, at, g.points)).collect();
    let standing = standing(&input.catalog_ref, &input.customer, &store_info.owner, &program, orders, grants)?;
    let event = Event::Spend { at: sys_time()?, cost: u64::from(reward.cost), min_tier: reward.min_tier };
    step(&program, standing.state.as_ref(), event).map(|_| ()).map_err(|reason| {
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
/// program -- what its members' points are worked out from. Safe to repeat.
#[hdk_extern]
pub fn record_member_order(input: MemberOrderInput) -> ExternResult<()> {
    let Some(record) = get(input.order.clone(), GetOptions::default())? else { return Ok(()) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(()) };
    let Some(rewards) = placed.rewards.clone() else { return Ok(()) };
    if placed.merchant != me()? {
        return Ok(());
    }
    let types = [EntryType::try_from(UnitEntryTypes::MemberOrder)?];
    if mine(&types).any(|r| decode_or::<MemberOrder>(r).is_some_and(|m| m.order == input.order))? {
        return Ok(());
    }
    let reward = match rewards.reward {
        Some(id) => program_at(&rewards.program, &placed.catalog_ref)?.ok().and_then(|p| p.reward(id).map(|r| (id, r.cost, r.min_tier))),
        None => None,
    };
    create_entry(&EntryTypes::MemberOrder(MemberOrder { catalog_ref: placed.catalog_ref, customer: placed.requester, order: input.order, accepted: input.accepted, reward }))?;
    Ok(())
}
