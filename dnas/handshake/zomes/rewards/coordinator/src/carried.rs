//! A store's rewards carried with it when its owner republishes it: after
//! recovering their account on a new key (`catalog::move_store`), or onto a
//! new network (`catalog::import_store`). See docs/REWARDS.md, "When a
//! store moves".
//!
//! - **The program** is copied to the new store, naming the copies of its
//!   items and choice groups (`carry_program`).
//! - **Members' points, on the same network**, carry on by themselves: the
//!   new store plays a member's history across its whole line of stores
//!   (`store::member_orders`). Only gifts the old key gave stay behind:
//!   they're sealed to that key.
//! - **Members' points, on a new network**, are carried over as a grant on
//!   each member's first order at the new store (`carry_previous_points`):
//!   the old network's store -- the same person's old key, on this device's
//!   `previous` role -- works out what they held there, gifts and all.

use super::*;
use handshake_coordinator_support::call_role;
use rewards_integrity::ledger::OpenGrant;
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Debug)]
pub struct CarryProgramInput {
    pub from: ActionHash,
    pub to: ActionHash,
    /// Whether `from` is on the network before this one.
    pub previous: bool,
    /// Each copied item and choice group: its original, then its copy.
    pub items: Vec<(ActionHash, ActionHash)>,
    pub groups: Vec<(ActionHash, ActionHash)>,
}

/// Copies `from`'s program to the caller's store `to`, naming the copies of
/// what it names. Safe to repeat: a store with a program keeps it.
#[hdk_extern]
pub fn carry_program(input: CarryProgramInput) -> ExternResult<()> {
    if store(&input.to)?.owner != me()? {
        return Err(guest("Only the store's owner carries its program."));
    }
    if program_of(input.to.clone())?.is_some() {
        return Ok(());
    }
    let old: Option<ProgramView> = if input.previous {
        call_role("previous", "rewards", "program_of", input.from.clone())?.map_err(|why| guest(format!("couldn't read the store's program on the previous network: {why}")))?
    } else {
        program_of(input.from.clone())?
    };
    let Some(old) = old else { return Ok(()) };
    let items: BTreeMap<ActionHash, ActionHash> = input.items.into_iter().collect();
    let groups: BTreeMap<ActionHash, ActionHash> = input.groups.into_iter().collect();
    save_program(old.program.remapped(input.to, |item| items.get(item).cloned(), |group| groups.get(group).cloned()))?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CarriedBalanceInput {
    pub catalog_ref: ActionHash,
    pub member: AgentPubKey,
}

/// What `member` holds at the caller's store `catalog_ref` now -- asked by
/// the same store's owner on the next network, through its `previous` role,
/// to carry it over.
#[hdk_extern]
pub fn carried_balance(input: CarriedBalanceInput) -> ExternResult<u64> {
    if store(&input.catalog_ref)?.owner != me()? {
        return Err(guest("not this store's owner"));
    }
    let Some(program) = program_of(input.catalog_ref.clone())? else { return Ok(0) };
    let (_, folded) = store_standing(&input.catalog_ref, &input.member, &program, Vec::new(), Vec::new())?;
    Ok(folded.state.map_or(0, |state| state.balance))
}

/// The points `member` held at the store the caller's `catalog_ref` was
/// brought over from, on the network before -- granted to them here, citing
/// `order`, if there are any and they haven't been already. `Ok(None)`: none
/// to carry (the store wasn't brought over, the member didn't move, or held
/// nothing, or it's done). `Err`: the previous network couldn't say just
/// now -- try again on their next order.
pub(crate) fn carry_previous_points(catalog_ref: &ActionHash, member: &AgentPubKey, order: &ActionHash) -> ExternResult<Option<OpenGrant>> {
    let from: Option<ActionHash> = call_local("catalog", "imported_from", catalog_ref.clone())?.map_err(|why| guest(format!("imported_from: {why}")))?;
    let Some(from) = from else { return Ok(None) };
    if my_grant_payloads_to(catalog_ref, member)?.iter().any(|(_, _, g)| matches!(g.reason, GrantReason::Carried { .. })) {
        return Ok(None);
    }
    // The member's key on the network before, if they moved from it.
    let before: Option<AgentPubKey> = call_local("account", "arrived_from", member.clone())?.map_err(|why| guest(format!("arrived_from: {why}")))?;
    let Some(before) = before else { return Ok(None) };
    let held: u64 = call_role("previous", "rewards", "carried_balance", CarriedBalanceInput { catalog_ref: from.clone(), member: before })?.map_err(|why| guest(format!("couldn't read the previous network: {why}")))?;
    let Ok(points) = u32::try_from(held) else { return Err(guest("that balance is too large to carry")) };
    if points == 0 {
        return Ok(None);
    }
    let payload = GrantPayload { points, reason: GrantReason::Carried { from } };
    let hash = grant(member.clone(), catalog_ref.clone(), Some(order.clone()), points, payload.reason.clone())?;
    let at = get(hash.clone(), GetOptions::local())?.map_or(sys_time()?, |r| r.action().timestamp());
    Ok(Some(open_grant(hash, at, &payload)))
}
