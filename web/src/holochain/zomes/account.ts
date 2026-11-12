// Accounts: a person's recovery plan, guardians vouching, a new key
// recovering an account whose key was lost, moving to the next network,
// and whether this device can send its key to a new phone. See the account
// zome, and docs/RECOVERY.md.
import { callPrevious, callZome } from "../client";
import type { ActionHash, AgentPubKey, MoveReadiness, PlanView, RecoveryPlan, Succession, SuccessionView, VouchView } from "../types";

export async function setRecoveryPlan(plan: RecoveryPlan): Promise<PlanView> {
  return callZome("account", "set_recovery_plan", plan);
}

export async function myRecoveryPlan(): Promise<PlanView | null> {
  return callZome("account", "my_recovery_plan", null);
}

/// Publishes the caller's recovery plan again, unchanged, once their chain
/// has run far past it -- so recovering the account stays cheap to validate
/// however long it's in use. Whether it did.
export async function reaffirmRecoveryPlan(): Promise<boolean> {
  return callZome("account", "reaffirm_recovery_plan", null);
}

export async function recoveryPlanOf(account: AgentPubKey): Promise<PlanView | null> {
  return callZome("account", "recovery_plan_of", account);
}

/// The accounts a recovery phrase's key recovers.
export async function accountsForPhraseKey(key: AgentPubKey): Promise<PlanView[]> {
  return callZome("account", "accounts_for_phrase_key", key);
}

/// The accounts the caller guards.
export async function myWards(): Promise<PlanView[]> {
  return callZome("account", "my_wards", null);
}

/// The caller, a guardian, vouching that `successor` is the person behind
/// `account`.
export async function vouch(account: AgentPubKey, successor: AgentPubKey): Promise<ActionHash> {
  return callZome("account", "vouch", { account, successor });
}

export async function vouchesForMe(): Promise<VouchView[]> {
  return callZome("account", "vouches_for_me", null);
}

export async function takeOver(succession: Succession): Promise<ActionHash> {
  return callZome("account", "take_over", succession);
}

export async function mySuccession(): Promise<SuccessionView | null> {
  return callZome("account", "my_succession", null);
}

/// Every key that has taken over `account` -- none while it's in use.
export async function successionsOf(account: AgentPubKey): Promise<SuccessionView[]> {
  return callZome("account", "successions_of", account);
}

export async function latestActionOf(agent: AgentPubKey): Promise<ActionHash | null> {
  return callZome("account", "latest_action_of", agent);
}

/// Where the network stands on this device's chain: whether it holds
/// everything this device wrote, so a new phone restoring the account from
/// it gets all of it.
export async function readyToMove(): Promise<MoveReadiness> {
  return callZome("account", "ready_to_move", null);
}

/// The old phone, about to send its key: marks the handover -- from now
/// on it writes nothing of its own accord -- and returns the head its chain
/// ends at, which goes in the sealed key.
export async function beginHandover(): Promise<ActionHash> {
  return callZome("account", "begin_handover", null);
}

/// The old phone taking its account back: refused once the network shows
/// the new phone has written as it (docs/RECOVERY.md).
export async function takeBack(): Promise<void> {
  return callZome("account", "take_back", { head: null });
}

/// The new phone, before it writes anything: its restored chain still ends
/// where the old phone handed it over (`head`, from the sealed key).
/// Refused if the old phone took it back meanwhile.
export async function confirmHandover(head: ActionHash): Promise<void> {
  return callZome("account", "confirm_handover", { head });
}

// --- moving to the next version of the network (docs/MIGRATION.md) ---

/// Moves the caller's account to the next network and closes its chain here.
export async function migrateOut(input: { network: Uint8Array; successor: AgentPubKey; parcel: string }): Promise<ActionHash> {
  return callZome("account", "migrate_out", input);
}

/// Whether `agent` closed their chain here, and the network they moved to.
export async function chainClosed(agent: AgentPubKey): Promise<{ network: Uint8Array | null; close: ActionHash } | null> {
  return callZome("account", "chain_closed", agent);
}

/// The accounts moved to the caller's key, read on the previous network.
export async function migrationsToMeOnPrevious(): Promise<{ account: AgentPubKey; close: ActionHash | null; network: Uint8Array }[]> {
  return callPrevious("account", "migrations_to_me", null);
}

/// What the old account (`account`) sealed to the caller's key, opened on
/// the previous network -- only its own.
export async function openParcelsOnPrevious(account: AgentPubKey): Promise<string[]> {
  return callPrevious("account", "open_parcels", account);
}

/// Records the caller's arrival from the previous network; returns the
/// account they arrived as. Safe to repeat.
export async function arrive(): Promise<AgentPubKey> {
  return callZome("account", "arrive", null);
}

/// Who `agent` was on the previous network, checked there.
export async function arrivedFrom(agent: AgentPubKey): Promise<AgentPubKey | null> {
  return callZome("account", "arrived_from", agent);
}
