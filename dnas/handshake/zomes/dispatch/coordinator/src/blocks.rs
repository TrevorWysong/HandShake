//! Blocks and customers' scores, as dispatch needs them (docs/REPUTATION.md,
//! phase 4) -- read from the reputation zome. Where two parties meet --
//! ordering from a store, a store taking an order, a driver bidding, a
//! customer taking a bid -- a block either way stops it here, the honest
//! app's side; the other party's own app refuses it too.

use handshake_coordinator_support::{call_local, guest};
use hdk::prelude::*;

/// One side of a block -- `reputation_integrity::Party`'s shape.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub(crate) enum Party {
    Person(AgentPubKey),
    Store(ActionHash),
}

/// Whether any of `pairs` is blocked, either way.
pub(crate) fn any_blocked(pairs: Vec<(Party, Party)>) -> ExternResult<bool> {
    Ok(blocked_each(pairs)?.into_iter().any(|blocked| blocked))
}

/// Whether each of `pairs` is blocked, read together.
pub(crate) fn blocked_each(pairs: Vec<(Party, Party)>) -> ExternResult<Vec<bool>> {
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    call_local::<_, Vec<bool>>("reputation", "blocked_pairs", pairs)?.map_err(|why| guest(format!("blocked_pairs: {why}")))
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
