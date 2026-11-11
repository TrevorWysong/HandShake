//! A new key recovering an account whose key was lost: on the recovery
//! phrase, or on guardians -- see docs/RECOVERY.md. No money comes with
//! it: that's in its owner's own processor account, which the new key
//! reconnects.

use crate::{decoded, guest, linked_records, own_links, recovery_plan_of};
use account_integrity::*;
use hdk::prelude::*;

/// How far back an account's line of keys is followed.
const MAX_LINEAGE: usize = 16;

/// The caller recovering `succession.predecessor`'s account.
#[hdk_extern]
pub fn take_over(succession: Succession) -> ExternResult<ActionHash> {
    if my_succession(())?.is_some() {
        return Err(guest("This device has already taken over an account."));
    }
    let predecessor = succession.predecessor.clone();
    let hash = create_entry(&EntryTypes::Succession(succession))?;
    create_link(predecessor, hash.clone(), LinkTypes::PredecessorToSuccession, ())?;
    create_link(agent_info()?.agent_initial_pubkey, hash.clone(), LinkTypes::SuccessorToSuccession, ())?;
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuccessionKind {
    Phrase,
    Guardians,
}

/// One key taking over another's account.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SuccessionView {
    pub succession: ActionHash,
    pub predecessor: AgentPubKey,
    pub successor: AgentPubKey,
    pub kind: SuccessionKind,
    /// The plan the recovery rested on.
    pub plan: ActionHash,
    pub at: Timestamp,
}

fn view_of(record: &Record) -> Option<SuccessionView> {
    let succession = decoded::<Succession>(record)?;
    let (kind, plan) = match succession.authority {
        Authority::Phrase { plan, .. } => (SuccessionKind::Phrase, plan),
        Authority::Guardians { plan, .. } => (SuccessionKind::Guardians, plan),
    };
    Some(SuccessionView { succession: record.action_address().clone(), predecessor: succession.predecessor, successor: record.action().author().clone(), kind, plan, at: record.action().timestamp() })
}

/// Whether a recovery still stands: while its plan is still the account's
/// current one. Validation
/// can only check the plan was current as of the point in the account's
/// history the recovery cites -- which could be an old point, before the
/// person replaced a phrase that leaked or dropped a guardian. So everyone
/// asks again when they look, and a replaced plan recovers nothing.
fn stands(view: &SuccessionView) -> ExternResult<bool> {
    Ok(recovery_plan_of(view.predecessor.clone())?.is_some_and(|current| current.plan == view.plan))
}

/// The account the caller's key took over, if it did.
#[hdk_extern]
pub fn my_succession(_: ()) -> ExternResult<Option<SuccessionView>> {
    Ok(crate::my_linked(LinkTypes::SuccessorToSuccession)?.first().and_then(view_of))
}

/// Every key that has taken over `account` and still stands (`stands`) --
/// none while it's in use. More than one means someone recovered it who
/// shouldn't have, or it was recovered twice: apps treat it as moved on
/// either way, and none of them carries it on (`successor_of`).
#[hdk_extern]
pub fn successions_of(account: AgentPubKey) -> ExternResult<Vec<SuccessionView>> {
    let mut standing = Vec::new();
    for view in linked_records(LinkQuery::try_new(account.clone(), LinkTypes::PredecessorToSuccession)?, GetStrategy::default())?.iter().filter_map(view_of) {
        if view.predecessor == account && stands(&view)? {
            standing.push(view);
        }
    }
    Ok(standing)
}

/// The key that carries `account` on: the one whose succession of it still
/// stands, if exactly one does. Validation can't see the whole network, so
/// it can't stop two keys taking over one account -- its recovery phrase
/// signing for both, say -- but here they cancel out: neither inherits its
/// history, ratings or stores. Recovering an account twice never hands it to
/// two keys, or to whichever one someone with a leaked phrase made.
#[hdk_extern]
pub fn successor_of(account: AgentPubKey) -> ExternResult<Option<AgentPubKey>> {
    let mut successors: Vec<AgentPubKey> = successions_of(account)?.into_iter().map(|view| view.successor).collect();
    successors.sort_by(|a, b| a.get_raw_39().cmp(b.get_raw_39()));
    successors.dedup();
    Ok(match successors.as_slice() {
        [only] => Some(only.clone()),
        _ => None,
    })
}

/// The keys `agent`'s account had before it, newest first -- whose ratings
/// and history are its own: each one only while `agent`'s line is the one
/// that carries it on (`successor_of`).
#[hdk_extern]
pub fn lineage(agent: AgentPubKey) -> ExternResult<Vec<AgentPubKey>> {
    let mut line: Vec<AgentPubKey> = Vec::new();
    let mut current = agent;
    while line.len() < MAX_LINEAGE {
        let Some(view) = linked_records(own_links(&current, LinkTypes::SuccessorToSuccession)?, GetStrategy::default())?.iter().filter_map(view_of).find(|v| v.successor == current) else { break };
        if line.contains(&view.predecessor) || successor_of(view.predecessor.clone())?.as_ref() != Some(&current) {
            break;
        }
        line.push(view.predecessor.clone());
        current = view.predecessor;
    }
    Ok(line)
}

/// The latest action the network has seen on `agent`'s chain -- where their
/// account stands, for a recovery to cite.
#[hdk_extern]
pub fn latest_action_of(agent: AgentPubKey) -> ExternResult<Option<ActionHash>> {
    handshake_coordinator_support::chain::chain_head_of(&agent)
}
