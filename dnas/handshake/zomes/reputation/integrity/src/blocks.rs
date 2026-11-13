//! Blocks (docs/REPUTATION.md, phase 4): any party -- a person in any role,
//! or a store -- blocking any other, so the two no longer see or deal with
//! each other. Either side's block hides the pair; only whoever made it
//! lifts it. Never automatic, never counted, never shown to anyone else.
//!
//! A block is a link at the pair's key: a hash of the two parties, the
//! same whichever blocked whom. Nobody can list a person's or a store's
//! blocks from it -- only check a pair they already know both sides of. Its
//! maker's own list is a private entry on their chain (`PartyBlock`).

use crate::*;

/// One side of a block: a person, whatever role they act in, or a store.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Party {
    Person(AgentPubKey),
    /// A store, by its catalog's original action.
    Store(ActionHash),
}

impl Party {
    /// What the party is as a link target.
    pub fn as_target(&self) -> AnyLinkableHash {
        match self {
            Party::Person(agent) => agent.clone().into(),
            Party::Store(catalog) => catalog.clone().into(),
        }
    }
}

/// The two parties of a pair, in order -- hashed for its key.
#[hdk_entry_helper]
#[derive(Clone)]
struct PairKey {
    first: Party,
    second: Party,
}

/// Where a block between `a` and `b` is found, whichever made it.
pub fn pair_key(a: &Party, b: &Party) -> ExternResult<AnyLinkableHash> {
    let (first, second) = if a <= b { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
    Ok(hash_entry(PairKey { first, second })?.into())
}

/// A block link's tag: who made it, as which party, and whom it blocks --
/// what validation checks the link's key and author against.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, SerializedBytes)]
pub struct BlockTag {
    pub by: Party,
    pub blocked: Party,
}

/// A block's maker's own record of it, private to their chain: the list
/// they manage and lift from. Append-only -- a lift is a later record
/// saying so (private entries are never updated, docs/HOLOCHAIN_ISSUES.md).
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
pub(crate) fn speaks_for(party: &Party, author: &AgentPubKey) -> ExternResult<bool> {
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

/// A block link: made by a party, at the key of the pair it names, to the
/// other party -- never to itself.
pub(crate) fn validate_block_link(base: &AnyLinkableHash, target: &AnyLinkableHash, tag: &LinkTag, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Ok(block) = BlockTag::try_from(SerializedBytes::from(UnsafeBytes::from(tag.0.clone()))) else {
        return Ok(ValidateCallbackResult::Invalid("a block names who made it and whom it blocks".into()));
    };
    if block.by == block.blocked {
        return Ok(ValidateCallbackResult::Invalid("nobody blocks themselves".into()));
    }
    if !speaks_for(&block.by, author)? {
        return Ok(ValidateCallbackResult::Invalid("a block is made by the person, or the store's owner, it says made it".into()));
    }
    if base != &pair_key(&block.by, &block.blocked)? || target != &block.blocked.as_target() {
        return Ok(ValidateCallbackResult::Invalid("a block sits at its pair's key, pointing at whom it blocks".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// A block's tag, for `by` blocking `blocked`.
pub fn block_tag(by: &Party, blocked: &Party) -> ExternResult<LinkTag> {
    let bytes = SerializedBytes::try_from(BlockTag { by: by.clone(), blocked: blocked.clone() }).map_err(|e| wasm_error!(e))?;
    Ok(LinkTag::new(bytes.bytes().to_vec()))
}
