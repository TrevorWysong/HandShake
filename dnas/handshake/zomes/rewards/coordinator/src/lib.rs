//! Coordinator zome for rewards: a store's program, and its members' points.
//! Points are private between a member and a store: nothing about them is
//! published. Both sides work them out with the same pure rules
//! (`rewards_types::points::replay`) -- the store from its own records
//! (the orders it accepted from the member, its settlements, its grants)
//! before it honours a reward; the member's app from their own orders, to
//! show them where they stand and what's on its way. See docs/REWARDS.md.

use handshake_coordinator_support::chain::{my_current_version, my_versions, mine};
use handshake_coordinator_support::{call_local, decode_or, guest, open, original_action_of, resolve_version, seal, update_version};
use hdk::prelude::*;
use rewards_integrity::*;

mod birthdays;
mod grants;
mod history;
mod member;
mod programs;
mod stats;
mod store;
use birthdays::*;
use grants::*;
use history::*;
use member::*;
use programs::*;
use store::*;

fn me() -> ExternResult<AgentPubKey> {
    Ok(agent_info()?.agent_initial_pubkey)
}

fn dispatch<I: Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(function: &str, input: I) -> ExternResult<O> {
    call_local("dispatch", function, input)?.map_err(|why| guest(format!("{function}: {why}")))
}

/// The store `catalog_ref` is, and its owner.
fn store(catalog_ref: &ActionHash) -> ExternResult<catalog_types::MerchantCatalog> {
    let record = get(catalog_ref.clone(), GetOptions::default())?.ok_or(guest("That store couldn't be found."))?;
    decode_or(&record).ok_or(guest("That isn't a store."))
}

// --- programs ---

// --- what happened, as the rules see it ---

// --- the store's side ---

// --- grants ---

// --- the member's side ---

// --- birthdays ---

/// Celebrates birthdays and tells new stores a member's month, a few times
/// a day, whether or not the app is open. Scheduled at `init`.
#[hdk_extern(infallible)]
pub fn rewards_periodically(_: Option<Schedule>) -> Option<Schedule> {
    let _ = celebrate_birthdays(());
    let _ = share_birthdays(());
    Some(Schedule::Persisted("0 7 */3 * * * *".into()))
}

#[hdk_extern]
pub fn init() -> ExternResult<InitCallbackResult> {
    prepare_device(())?;
    Ok(InitCallbackResult::Pass)
}

/// This device's background work, set up if it isn't (see dispatch's
/// `prepare_device`).
#[hdk_extern]
pub fn prepare_device(_: ()) -> ExternResult<()> {
    schedule("rewards_periodically")?;
    Ok(())
}

// --- a store's view ---

#[cfg(feature = "test-utils")]
mod test_utils {
    use super::*;

    /// Writes a program exactly as given -- a forgery a modified app would
    /// try, for validation tests.
    #[hdk_extern]
    pub fn create_raw_program_for_testing(program: RewardsProgram) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::RewardsProgram(program))
    }

    /// A grant sealed by the caller, about any store -- what a stranger
    /// pretending to be a store would write.
    #[hdk_extern]
    pub fn create_raw_points_grant_for_testing(input: GrantInput) -> ExternResult<ActionHash> {
        let sealed = seal(&input.to, &GrantPayload { points: input.points, reason: GrantReason::Goodwill { note: input.note } })?;
        let order = input.order.ok_or(guest("a raw grant names its order"))?;
        let hash = create_entry(&EntryTypes::PointsGrant(PointsGrant { to: input.to.clone(), catalog_ref: input.catalog_ref, order, sealed }))?;
        create_link(input.to, hash.clone(), LinkTypes::AgentToGrant, ())?;
        Ok(hash)
    }

    handshake_coordinator_support::raw_link_test_externs!(CatalogToProgram, AgentToGrant, CatalogToBirthday);
}
