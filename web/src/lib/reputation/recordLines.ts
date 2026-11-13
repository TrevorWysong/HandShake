// A record as people read it, in one set of words: what a store or driver
// sees of a customer, and what customers and drivers see of a store -- and
// what each sees of their own (docs/REPUTATION.md, "Seen by its subject").
// One place, so nobody is ever shown about themselves anything worded
// differently from what others are shown.
import type { ReputationSummary } from "../../holochain/types";
import type { Translate } from "../../i18n";

/// A customer's record: contested claims, no-shows, orders called off.
export function customerRecordLines(summary: ReputationSummary, t: Translate): string[] {
  return [
    summary.dispute_resolved_against_count > 0 && t("history.contested", { count: summary.dispute_resolved_against_count }),
    summary.no_show_count > 0 && t("history.noShows", { count: summary.no_show_count }),
    summary.cancelled_by_them_count > 0 && t("history.cancelled", { count: summary.cancelled_by_them_count }),
  ].filter((line): line is string => !!line);
}

/// A store's record: drivers kept waiting, drivers' check-in reports,
/// orders it called off.
export function storeRecordLines(record: ReputationSummary, t: Translate): string[] {
  return [
    record.late_count > 0 && t("store.late", { count: record.late_count }),
    record.check_in_refused_count > 0 && t("store.reports", { count: record.check_in_refused_count }),
    record.cancelled_by_them_count > 0 && t("store.calledOff", { count: record.cancelled_by_them_count }),
  ].filter((line): line is string => !!line);
}
