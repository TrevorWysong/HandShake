//! Moving an account to a new phone keeps its key: the old phone sends the
//! key, sealed, to the new one, which rebuilds the account's chain from the
//! network (Holochain's restore) and carries on as the same account -- same
//! history, stores, balance and orders in hand. See docs/RECOVERY.md.
//!
//! The one thing that must never happen is both phones writing as the
//! account: two chains with the same key fork it, and the network refuses
//! a forked account for good. So the old phone stops for good once it has
//! sent the key, and sends it only when the network already holds
//! everything it wrote -- what the new phone restores from.

use account_integrity::{EntryTypes, Handover, HandoverEnded, UnitEntryTypes};
use hdk::prelude::*;

/// Whether this device can hand its key to a new phone now.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct MoveReadiness {
    /// This device's latest action, and its place on the chain.
    pub head: ActionHash,
    pub seq: u32,
    /// The latest action the network's authorities for this account hold,
    /// as far as they answered -- none when none did.
    pub seen: Option<u32>,
    /// Whether they hold this device's latest action, cleanly: everything
    /// it wrote is out, so a new phone restoring the account gets all of it.
    pub ready: bool,
}

/// Where the network stands on the caller's chain, against where this
/// device does. Asked of the network only: this device's own copy always
/// agrees with itself.
#[hdk_extern]
pub fn ready_to_move(_: ()) -> ExternResult<MoveReadiness> {
    let info = agent_info()?;
    let (head, seq, _) = info.chain_head;
    let activity = get_agent_activity(info.agent_initial_pubkey, ChainQueryFilter::new(), ActivityRequest::Status, GetOptions::network())?;
    let seen = match &activity.status {
        ChainStatus::Valid(network_head) => Some(network_head.action_seq),
        _ => activity.highest_observed.as_ref().map(|h| h.action_seq),
    };
    let ready = activity.warrants.is_empty() && matches!(&activity.status, ChainStatus::Valid(network_head) if network_head.hash == head);
    Ok(MoveReadiness { head, seq, seen, ready })
}

// --- handing over without forking ---

/// The handover this device is in, if it is: its latest `Handover`, not
/// followed by a `HandoverEnded`. Read from this device alone -- both are
/// private, so a new phone restoring the chain never holds them.
fn handover_in_progress() -> ExternResult<Option<ActionHash>> {
    let types = [UnitEntryTypes::Handover.try_into()?, UnitEntryTypes::HandoverEnded.try_into()?];
    let Some(latest) = handshake_coordinator_support::chain::mine(&types).latest()? else { return Ok(None) };
    Ok(handshake_coordinator_support::decode_or::<Handover>(&latest).map(|_| latest.action_address().clone()))
}

/// Whether this device is handing its account over: while it is, it writes
/// nothing of its own accord -- its background work and setup wait
/// (`handshake_coordinator_support::handing_over`).
#[hdk_extern]
pub fn handing_over(_: ()) -> ExternResult<bool> {
    Ok(handover_in_progress()?.is_some())
}

/// The old phone, about to send its key: marks the handover, and returns
/// the chain's head with it -- what the new phone restores to, carried in
/// the sealed key (`confirm_handover`). The app waits for `ready_to_move`
/// to show the network holds it before sending. Safe to repeat.
#[hdk_extern]
pub fn begin_handover(_: ()) -> ExternResult<ActionHash> {
    if let Some(handover) = handover_in_progress()? {
        return Ok(handover);
    }
    create_entry(&EntryTypes::Handover(Handover { started_at: sys_time()? }))
}

/// Where the network's authorities stand on the account's chain, against
/// `head` -- the action at `seq` on it.
enum NetworkSays {
    /// It ends at `head`, cleanly: nobody has written past it.
    EndsThere,
    /// Someone has written past it -- another phone, as this account.
    WrittenPast,
    /// It can't say yet: no answer, or not caught up with `head`.
    NotSure,
}

fn network_on(head: &ActionHash, seq: u32) -> ExternResult<NetworkSays> {
    let activity = get_agent_activity(agent_info()?.agent_initial_pubkey, ChainQueryFilter::new(), ActivityRequest::Status, GetOptions::network())?;
    let past = activity.highest_observed.as_ref().is_some_and(|seen| seen.action_seq > seq);
    Ok(match &activity.status {
        _ if past || !activity.warrants.is_empty() => NetworkSays::WrittenPast,
        ChainStatus::Valid(network_head) if &network_head.hash == head => NetworkSays::EndsThere,
        ChainStatus::Valid(network_head) if network_head.action_seq > seq => NetworkSays::WrittenPast,
        _ => NetworkSays::NotSure,
    })
}

fn not_sure() -> WasmError {
    handshake_coordinator_support::guest("The network hasn't caught up with this account yet. Keep HandShake open and online, then try again in a moment.")
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HandoverCheck {
    /// Where the chain ended as the old phone handed it over (the new
    /// phone's, from the sealed key) -- unused when taking back.
    #[serde(default)]
    pub head: Option<ActionHash>,
}

/// Both "phones" are one node: the dev host's network says so itself
/// (`handshake_governance::dev_one_node`), never a caller. There the network
/// never reports a chain only that node holds, and there's no other phone
/// to fork it with, so its checks don't apply.
fn one_node() -> bool {
    handshake_governance::dev_one_node()
}

/// The old phone taking its account back from a handover: only if the
/// network shows the account's chain still ends where this device left
/// it -- the new phone never wrote as it. Otherwise refused: the account
/// lives on the new phone, and this device can only let it go (`retire`).
/// Two phones writing as one account would fork it for good.
#[hdk_extern]
pub fn take_back(_: HandoverCheck) -> ExternResult<()> {
    let Some(handover) = handover_in_progress()? else { return Err(handshake_coordinator_support::guest("This device isn't handing its account over.")) };
    let (head, seq, _) = agent_info()?.chain_head;
    if !one_node() {
        match network_on(&head, seq)? {
            NetworkSays::EndsThere => {}
            NetworkSays::WrittenPast => return Err(handshake_coordinator_support::guest("Your new phone has started using this account, so this device can't take it back. Remove it from here: the account carries on on the new phone.")),
            NetworkSays::NotSure => return Err(not_sure()),
        }
    }
    create_entry(&EntryTypes::HandoverEnded(HandoverEnded { handover }))?;
    Ok(())
}

/// The new phone, its account restored, before it writes anything: the
/// chain still ends where the old phone handed it over (`head`, from the
/// sealed key), here and on the network. Refused if the old phone took it
/// back meanwhile: then it's the old phone's, and this one lets it go.
#[hdk_extern]
pub fn confirm_handover(check: HandoverCheck) -> ExternResult<()> {
    let refused = || handshake_coordinator_support::guest("Your other phone took this account back, so it can't be used here. Remove it from this phone, or move it again.");
    let head = check.head.ok_or_else(refused)?;
    let (here, seq, _) = agent_info()?.chain_head;
    // One node standing in for both phones (the dev host) shares one chain:
    // there's no other phone to fork it with, and the app's own connecting
    // writes its signing grant past the head before it can ask. Only the
    // handover's end, below. A real phone's runtime asks before anything
    // writes, as the account itself (runtime/device `receive`).
    if !one_node() && here != head {
        // Restored past the head: the old phone wrote after handing it over.
        return Err(refused());
    }
    if !one_node() {
        match network_on(&head, seq)? {
            NetworkSays::EndsThere => {}
            NetworkSays::WrittenPast => return Err(refused()),
            NetworkSays::NotSure => return Err(not_sure()),
        }
    }
    // One node standing in for both phones holds the old one's handover
    // too: it ends here, as this device carries on. A real new phone never
    // holds it -- it's private to the old one.
    if let Some(handover) = handover_in_progress()? {
        create_entry(&EntryTypes::HandoverEnded(HandoverEnded { handover }))?;
    }
    Ok(())
}
