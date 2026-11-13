// Customers rated by the stores and drivers who served them, and blocks
// between any two parties (docs/REPUTATION.md, phase 4) -- as the app shows
// and uses them.
import type { CustomerReason, CustomerScore, Party } from "../../holochain/types";
import type { MessageKey } from "../../i18n";

export const CUSTOMER_REASONS: readonly CustomerReason[] = ["RudeOrAbusive", "Unreachable", "Unsafe", "AddressDetails", "OffApp", "Other"];

export const CUSTOMER_REASON_LABEL: Record<CustomerReason, MessageKey> = {
  RudeOrAbusive: "customerReason.RudeOrAbusive",
  Unreachable: "customerReason.Unreachable",
  Unsafe: "customerReason.Unsafe",
  AddressDetails: "customerReason.AddressDetails",
  OffApp: "customerReason.OffApp",
  Other: "customerReason.Other",
};

/// A customer's share of thumbs-up, in whole percent, once it's shown --
/// `null` before then, or with nothing counted.
export function scorePercent(score: CustomerScore): number | null {
  const rated = score.up + score.down;
  return score.shown && rated > 0 ? Math.floor((score.up * 100) / rated) : null;
}

/// Whether a score falls below a threshold someone chose -- never for a
/// customer without one shown yet: no history isn't a low score.
export function below(score: CustomerScore | null | undefined, threshold: number | null): boolean {
  if (threshold === null || !score) return false;
  const percent = scorePercent(score);
  return percent !== null && percent < threshold;
}

/// The same party, compared by key.
export function sameParty(a: Party, b: Party): boolean {
  const key = (p: Party) => ("Person" in p ? `p:${p.Person.join(",")}` : `s:${p.Store.join(",")}`);
  return key(a) === key(b);
}

/// The scores, in percent, a store or driver can choose to hold or skip
/// customers below -- each their own choice, off by default.
export const SCORE_THRESHOLDS: readonly number[] = [50, 60, 70, 80, 90];
