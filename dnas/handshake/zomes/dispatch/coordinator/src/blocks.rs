//! Blocks and customers' scores, as dispatch needs them (docs/REPUTATION.md,
//! phase 4). A block is checked where the parties meet, and never by asking
//! the network: against the caller's own private list (the reputation
//! zome's `my_blocks`, read from their chain), or against the fingerprints
//! the record in hand carries -- an order's customer's and store's lists,
//! a store's listing. Validation refuses a bid the order's lists name.

use handshake_coordinator_support::{call_local, guest};
use handshake_types::block_prints;
use hdk::prelude::*;

/// One side of a block -- `reputation_integrity::Party`'s shape.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub(crate) enum Party {
    Person(AgentPubKey),
    Store(ActionHash),
}

/// Whom the caller has blocked as `by`, most recent first, from their own
/// chain.
pub(crate) fn my_blocks(by: Party) -> ExternResult<Vec<Party>> {
    call_local::<_, Vec<Party>>("reputation", "my_blocks", by)?.map_err(|why| guest(format!("couldn't read your blocks: {why}")))
}

/// The caller's own blocks as themselves.
pub(crate) fn my_own_blocks() -> ExternResult<Vec<Party>> {
    my_blocks(Party::Person(agent_info()?.agent_initial_pubkey))
}

/// Fresh salt for a record's list.
pub(crate) fn new_salt() -> ExternResult<Vec<u8>> {
    Ok(random_bytes(block_prints::SALT_BYTES as u32)?.into_vec())
}

/// The people among `blocked` as a record's padded list under `salt`.
pub(crate) fn people_list(salt: &[u8], blocked: &[Party]) -> ExternResult<Vec<u8>> {
    let keys: Vec<&[u8]> = blocked.iter().filter_map(|party| match party {
        Party::Person(agent) => Some(agent.get_raw_39()),
        Party::Store(_) => None,
    }).collect();
    let decoys = random_bytes(block_prints::decoy_bytes(keys.len()) as u32)?.into_vec();
    Ok(block_prints::list(salt, &keys, &decoys))
}

/// Whether a store's listing names `person` among those it blocked.
pub(crate) fn store_lists(catalog: &catalog_types::MerchantCatalog, person: &AgentPubKey) -> bool {
    block_prints::lists(&catalog.blocked, &catalog.block_salt, person.get_raw_39())
}

#[derive(Deserialize, Debug)]
struct ScoreWire {
    up: u32,
    down: u32,
    shown: bool,
}

/// A customer's share of thumbs-up, in percent, once enough ratings count
/// to show it -- `None` before then.
pub(crate) fn customer_score(customer: &AgentPubKey) -> ExternResult<Option<u8>> {
    let score: ScoreWire = call_local::<_, ScoreWire>("reputation", "get_customer_score", customer.clone())?.map_err(|why| guest(format!("get_customer_score: {why}")))?;
    let rated = score.up + score.down;
    Ok((score.shown && rated > 0).then(|| (score.up * 100 / rated) as u8))
}
