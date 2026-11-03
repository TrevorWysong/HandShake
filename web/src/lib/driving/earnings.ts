// A driver's earnings, from their payment history -- every fee, tip and
// late cover stores paid them, and the collateral they forfeited -- grouped
// by week or month. The money itself went straight to their own processor
// account; this is the record of what each store charged and why.
import type { AgentPubKey, PaymentHistoryItem } from "../../holochain/types";
import { bytesEqual } from "../../holochain/decode";

export interface EarningsPeriod {
  /// The period's first day, local midnight, in milliseconds.
  start: number;
  deliveries: number;
  fees: number;
  tips: number;
  /// What stores paid for keeping the driver waiting.
  lateCover: number;
  /// Collateral charged on orders that never arrived.
  forfeited: number;
}

export type Grouping = "week" | "month";

/// The local midnight starting `at`'s week (from Monday) or month.
export function periodStart(atMs: number, grouping: Grouping): number {
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  if (grouping === "month") d.setDate(1);
  else d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/// Earnings by period, newest first, for the driver `me`.
export function earningsByPeriod(items: PaymentHistoryItem[], me: AgentPubKey, grouping: Grouping): EarningsPeriod[] {
  const periods = new Map<number, EarningsPeriod>();
  const period = (atMicros: number) => {
    const start = periodStart(atMicros / 1000, grouping);
    let p = periods.get(start);
    if (!p) periods.set(start, (p = { start, deliveries: 0, fees: 0, tips: 0, lateCover: 0, forfeited: 0 }));
    return p;
  };
  for (const item of items) {
    if (item.charged === null || item.charged === 0) continue;
    const leg = item.leg;
    if (typeof leg === "object" && "DriverPay" in leg && bytesEqual(item.payee, me)) {
      const p = period(item.at);
      p.deliveries += 1;
      for (const { part, amount } of item.parts) {
        if (part.portion === "Fee") p.fees += amount;
        else if (part.portion === "Tip") p.tips += amount;
        else if (part.portion === "LateCover") p.lateCover += amount;
      }
    } else if (typeof leg === "object" && "Collateral" in leg && bytesEqual(item.payer, me)) {
      period(item.at).forfeited += item.charged;
    }
  }
  return [...periods.values()].sort((a, b) => b.start - a.start);
}

export const earned = (p: EarningsPeriod) => p.fees + p.tips + p.lateCover;

/// The periods as CSV, for the driver's own records or their accountant.
export function earningsCsv(periods: EarningsPeriod[], grouping: Grouping, minor: (cents: number) => string): string {
  const header = [grouping === "week" ? "Week starting" : "Month", "Deliveries", "Fees", "Tips", "Late cover", "Earned", "Collateral forfeited"];
  const day = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const lines = periods.map((p) => [day(p.start), p.deliveries, minor(p.fees), minor(p.tips), minor(p.lateCover), minor(earned(p)), minor(p.forfeited)].join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}
