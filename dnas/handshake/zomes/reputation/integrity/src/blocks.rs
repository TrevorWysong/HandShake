//! Blocks (docs/REPUTATION.md, phase 4): any party -- a person in any role,
//! or a store -- blocking any other, so the two no longer see or deal with
//! each other. Never automatic, never counted.
//!
//! A party's blocks are their maker's own list (`SealedBlocks`), sealed to
//! them: the list they manage and lift from. Sealed rather than private, so
//! it moves with the account to a new phone (private entries don't,
//! docs/HOLOCHAIN_ISSUES.md #10). Where the other side
//! has to know, the block travels in the record it applies to, as a salted
//! fingerprint (`handshake_types::block_prints`): an order carries the
//! people its customer and its store blocked -- validation refuses their
//! bids -- and a store's listing the people it blocked.

use crate::*;
use handshake_integrity_support::{sealed_chunks_problem, SealedChunks};

/// One side of a block: a person, whatever role they act in, or a store.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Party {
    Person(AgentPubKey),
    /// A store, by its catalog's original action.
    Store(ActionHash),
}

/// The most a sealed list of blocks holds, before sealing: every list its
/// maker keeps -- as themselves, and as each store of theirs -- of at most
/// `handshake_types::block_prints::most_real()` each.
pub const MAX_BLOCK_BOOK_BYTES: usize = 65_536;

/// Everyone an account has blocked, as itself and as each of its stores,
/// sealed to it and padded to whole boxes: nobody else learns whom, or --
/// beyond a step of about seventy -- how many. One per account, linked from
/// it (`OwnerToBlocks`), its later versions each a change of the list.
#[hdk_entry_helper]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct SealedBlocks {
    pub sealed: SealedChunks,
}

pub(crate) fn sealed_blocks_valid(blocks: &SealedBlocks) -> ExternResult<ValidateCallbackResult> {
    Ok(match sealed_chunks_problem("a list of blocks", &blocks.sealed, MAX_BLOCK_BOOK_BYTES) {
        Some(problem) => ValidateCallbackResult::Invalid(problem),
        None => ValidateCallbackResult::Valid,
    })
}

/// Only the account that wrote its list changes it.
pub(crate) fn validate_sealed_blocks_update(blocks: &SealedBlocks, author: &AgentPubKey, original: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let original = must_get_valid_record(original.clone())?;
    if original.action().author() != author || decode::<SealedBlocks>(&original).is_none() {
        return Ok(ValidateCallbackResult::Invalid("someone's list of blocks is changed only by them".into()));
    }
    sealed_blocks_valid(blocks)
}

/// An `OwnerToBlocks` link: from the account, to its own first list.
pub(crate) fn validate_blocks_link(base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if base.clone().into_agent_pub_key().as_ref() != Some(author) {
        return Ok(ValidateCallbackResult::Invalid("an account links only its own blocks".into()));
    }
    let Some(target) = target.clone().into_action_hash() else {
        return Ok(ValidateCallbackResult::Invalid("an account's blocks link to its list".into()));
    };
    let record = must_get_valid_record(target)?;
    let is_list = record.action().author() == author && matches!(&record.action().data, ActionData::Create(_)) && decode::<SealedBlocks>(&record).is_some();
    Ok(match is_list {
        true => ValidateCallbackResult::Valid,
        false => ValidateCallbackResult::Invalid("an account's blocks link to its own list, as first written".into()),
    })
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
