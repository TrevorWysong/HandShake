// A store's findings on a report (docs/REPUTATION.md): that it wasn't made
// in good faith, or that the driver was at fault -- each from a fixed list
// of reasons, so nothing free-written about anyone is published.
import type { BadFaithReason, FaultReason, Finding } from "../../holochain/types";
import type { MessageKey } from "../../i18n";

export const BAD_FAITH_REASONS: readonly BadFaithReason[] = ["ItemWasIncluded", "EvidenceDoesNotMatch", "RepeatedClaim", "Other"];
export const FAULT_REASONS: readonly FaultReason[] = ["Late", "ColdOrSpilled", "WrongPlace", "Conduct", "Other"];

export const BAD_FAITH_LABEL: Record<BadFaithReason, MessageKey> = {
  ItemWasIncluded: "finding.badFaith.ItemWasIncluded",
  EvidenceDoesNotMatch: "finding.badFaith.EvidenceDoesNotMatch",
  RepeatedClaim: "finding.badFaith.RepeatedClaim",
  Other: "finding.badFaith.Other",
};

export const FAULT_LABEL: Record<FaultReason, MessageKey> = {
  Late: "finding.fault.Late",
  ColdOrSpilled: "finding.fault.ColdOrSpilled",
  WrongPlace: "finding.fault.WrongPlace",
  Conduct: "finding.fault.Conduct",
  Other: "finding.fault.Other",
};

/// What a finding says, as a reason's words.
export function findingLabel(finding: Finding): MessageKey {
  return "BadFaith" in finding ? BAD_FAITH_LABEL[finding.BadFaith] : FAULT_LABEL[finding.DriverAtFault];
}

/// Whether other stores are shown a customer's findings: only once enough
/// different stores have made one (`min_flagging_stores`) -- one store's
/// view of a customer never follows them.
export function shownToStores(flaggingStores: number, minStores: number): boolean {
  return flaggingStores >= Math.max(1, minStores);
}
