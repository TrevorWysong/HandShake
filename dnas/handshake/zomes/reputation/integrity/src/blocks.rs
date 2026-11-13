//! Blocks (docs/REPUTATION.md, phase 4): any party -- a person in any role,
//! or a store -- blocking any other, so the two no longer see or deal with
//! each other. Never automatic, never counted.
//!
//! A block is its maker's own private record (`PartyBlock`): the list they
//! manage and lift from, read on their own device. Where the other side
//! has to know, the block travels in the record it applies to, as a salted
//! fingerprint (`handshake_types::block_prints`): an order carries the
//! people its customer and its store blocked -- validation refuses their
//! bids -- and a store's listing the people it blocked.

use crate::*;

/// One side of a block: a person, whatever role they act in, or a store.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Party {
    Person(AgentPubKey),
    /// A store, by its catalog's original action.
    Store(ActionHash),
}

/// A block's maker's own record of it, private to their chain.
/// Append-only -- a lift is a later record saying so (private entries are
/// never updated, docs/HOLOCHAIN_ISSUES.md).
#[hdk_entry_helper]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct PartyBlock {
    pub by: Party,
    pub blocked: Party,
    /// Blocked, or lifted.
    pub on: bool,
}

/// Whether `author` speaks for `party`: is that person, or owns that store.
pub fn speaks_for(party: &Party, author: &AgentPubKey) -> ExternResult<bool> {
    Ok(match party {
        Party::Person(agent) => agent == author,
        Party::Store(catalog) => {
            if &original_creation(catalog.clone())? != catalog {
                return Ok(false);
            }
            must_get_valid_record(catalog.clone())?.action().author() == author
        }
    })
}
