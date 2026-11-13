// Whether pairs of parties are blocked (docs/REPUTATION.md, phase 4), as
// screens that poll -- a driver's feed every few seconds, a customer's bids
// -- read it: each pair is looked up once and kept for a few minutes, so a
// poll costs only the pairs it hasn't seen. Never the authority: ordering,
// accepting and bidding check blocks themselves.
import { blockedPairs } from "../../holochain/zomes/reputation";
import type { Party } from "../../holochain/types";
import { bytesToHex } from "../../holochain/decode";
import { known } from "./blockMemo";

/// How long a looked-up pair is trusted before it's read again.
const KEEP_MS = 3 * 60_000;
/// The most pairs kept: a long shift's worth, then the oldest go.
const MOST = 2_000;

const partyKey = (party: Party) => ("Person" in party ? `p:${bytesToHex(party.Person)}` : `s:${bytesToHex(party.Store)}`);
/// A pair's key, the same either way round, as the network's is.
export const pairKey = (a: Party, b: Party) => [partyKey(a), partyKey(b)].sort().join("|");

/// Whether each pair is blocked, either way: kept answers where fresh, the
/// rest read together.
export async function blockedAmong(pairs: [Party, Party][], now = Date.now()): Promise<boolean[]> {
  const keys = pairs.map(([a, b]) => pairKey(a, b));
  const missing = new Map<string, [Party, Party]>();
  keys.forEach((key, i) => {
    const hit = known.get(key);
    if (!hit || now - hit.at > KEEP_MS) missing.set(key, pairs[i]!);
  });
  if (missing.size > 0) {
    const read = await blockedPairs([...missing.values()]);
    [...missing.keys()].forEach((key, i) => known.set(key, { blocked: read[i] ?? false, at: now }));
    while (known.size > MOST) known.delete(known.keys().next().value!);
  }
  return keys.map((key) => known.get(key)?.blocked ?? false);
}

export { forgetBlocks } from "./blockMemo";
