// Whether this device's account has moved on -- recovered onto another key,
// or moved to the next version of the network -- read before the app shows
// anything: a key whose account moved on mustn't carry on as if it hadn't.
// A read that fails is never taken for "it hasn't": it's tried again, and
// if it still can't be had, the session doesn't start (it shows why, and
// offers to try again). Never fail open.
import type { AgentPubKey } from "../../holochain/types";
import { retrying } from "../network/retry";

/// Where an account stands: the key it moved on to, if it was recovered,
/// and whether it moved to the next network.
export interface Standing {
  movedTo: AgentPubKey | null;
  movedToNewVersion: boolean;
}

/// The reads it rests on -- the account zome's, for this device's key.
export interface StandingReads {
  successions: () => Promise<{ successor: AgentPubKey }[]>;
  chainClosed: () => Promise<unknown | null>;
}

/// How long between tries of a read that failed: a conductor just started,
/// or the network still finding its peers, answers within seconds.
export const STANDING_RETRIES_MS = [500, 1_000, 2_000, 4_000] as const;

/// The account's standing, from both reads -- each tried again on failure,
/// and the whole refused if either still can't be had.
export async function accountStanding(reads: StandingReads, delaysMs: readonly number[] = STANDING_RETRIES_MS): Promise<Standing> {
  const [successions, closed] = await Promise.all([retrying(reads.successions, delaysMs), retrying(reads.chainClosed, delaysMs)]);
  return { movedTo: successions[0]?.successor ?? null, movedToNewVersion: closed !== null };
}
