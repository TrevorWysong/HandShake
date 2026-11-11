// Editing a recovery plan: each change replaces one part of it.
import type { AgentPubKey, PlanView } from "../../holochain/types";

/// The fewest of `count` guardians that may recover an account: more than
/// half, as the network requires -- two recoveries would each need a
/// guardian who vouched for both, and a guardian vouches once.
export const majorityOf = (count: number) => Math.floor(count / 2) + 1;

/// A plan with one part replaced, the rest as it was -- its threshold kept
/// within what the network takes.
export function planWith(plan: PlanView | null, change: { phrase_key?: AgentPubKey | null; guardians?: AgentPubKey[]; threshold?: number }) {
  const guardians = change.guardians ?? plan?.guardians ?? [];
  return {
    phrase_key: change.phrase_key === undefined ? (plan?.phrase_key ?? null) : change.phrase_key,
    guardians,
    threshold: guardians.length === 0 ? 0 : Math.max(majorityOf(guardians.length), Math.min(change.threshold ?? plan?.threshold ?? 1, guardians.length)),
  };
}
