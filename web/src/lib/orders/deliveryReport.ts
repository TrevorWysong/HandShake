// A customer telling the store the delivery itself let them down -- late,
// cold, spilled -- rather than any item: what they pick and write becomes
// the report's note, sealed to the store, within the network's note limit.
import { MAX_NOTE_CHARS } from "../../holochain/types";

export const DELIVERY_REASONS = ["late", "cold", "spilled", "wrongPlace", "conduct"] as const;
export type DeliveryReason = (typeof DELIVERY_REASONS)[number];

/// The note a report carries: the reasons picked, in their words, then
/// anything written -- never past `MAX_NOTE_CHARS`.
export function deliveryNote(reasons: readonly string[], details: string): string {
  return [reasons.join(", "), details.trim()].filter(Boolean).join(" — ").slice(0, MAX_NOTE_CHARS);
}

/// Room left for details once the reasons are in.
export function detailsRoom(reasons: readonly string[]): number {
  const taken = reasons.length > 0 ? reasons.join(", ").length + " — ".length : 0;
  return Math.max(0, MAX_NOTE_CHARS - taken);
}
