//! Whether someone's account has moved on to a new key -- recovered after
//! their device was lost. A key whose account moved on may
//! be in someone else's hands (a lost phone found), so a store doesn't take
//! its orders and a customer doesn't take its bids: the person carries on
//! from their new key. Asked of the account zome.

use hdk::prelude::*;
use handshake_coordinator_support::{call_local, guest};

/// Whether `agent`'s account has moved on to a new key. An unreachable
/// account zome says it hasn't: trade isn't blocked on it.
pub(crate) fn has_moved(agent: &AgentPubKey) -> ExternResult<bool> {
    #[derive(Deserialize, Debug)]
    struct Moved {}
    let successions: Result<Vec<Moved>, _> = call_local("account", "successions_of", agent.clone())?;
    Ok(successions.is_ok_and(|moves| !moves.is_empty()))
}

/// Refuses to deal with `agent` if their account has moved on; `who` names
/// them in the refusal ("This customer", "That driver").
pub(crate) fn ensure_not_moved(agent: &AgentPubKey, who: &str) -> ExternResult<()> {
    if has_moved(agent)? {
        return Err(guest(format!("{who}'s account has moved to a new device, so this key can't be used any more.")));
    }
    Ok(())
}
