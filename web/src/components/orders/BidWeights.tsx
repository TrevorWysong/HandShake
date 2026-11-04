// How the network's matching rule weighs a bid, shown with its working:
// the fee, the time it takes, and the driver's record -- so a customer sees
// why one bid is the best match, and a driver how their own will count.
// The numbers are the network's (`rank_bids`, `weigh_my_bid`), never worked
// out again here.
import type { ReactNode } from "react";
import type { BidWeight } from "../../holochain/types";
import { formatCents } from "../../lib/ui/format";
import { useTerms } from "../../store/network";
import { useT } from "../../i18n";
import { InfoSheet } from "../InfoSheet";

/// One bid's working: its fee, plus its time, plus its driver's record,
/// to what it counts as.
export function BidWeightBreakdown({ fee, weight }: { fee: number; weight: BidWeight }) {
  const t = useT();
  const terms = useTerms();
  const minutes = terms.minute_value_cents > 0 ? Math.round(weight.time_cost / terms.minute_value_cents) : 0;
  const rows = [
    { label: t("bidWeight.fee"), detail: null, amount: fee },
    { label: t("bidWeight.time"), detail: t("bidWeight.timeDetail", { minutes, each: formatCents(terms.minute_value_cents) }), amount: weight.time_cost },
    {
      label: t("bidWeight.record"),
      detail: weight.failed > 0 ? t("bidWeight.recordDetail", { failed: weight.failed, taken: weight.taken_on, clean: terms.clean_start_deliveries }) : t("bidWeight.recordClean"),
      amount: weight.reliability_cost,
    },
  ];
  return (
    <dl className="flex flex-col gap-2 text-xs">
      {rows.map((row, i) => (
        <div key={row.label} className="flex items-start justify-between gap-3">
          <dt>
            <span className="font-semibold text-ink-700 dark:text-ink-200">{row.label}</span>
            {row.detail && <span className="block text-[11px] text-ink-400">{row.detail}</span>}
          </dt>
          <dd className="shrink-0 tabular-nums text-ink-700 dark:text-ink-200">{i > 0 ? `+ ${formatCents(row.amount)}` : formatCents(row.amount)}</dd>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 border-t border-ink-100 pt-2 dark:border-ink-800">
        <dt className="font-bold text-ink-900 dark:text-ink-50">{t("bidWeight.countsAs")}</dt>
        <dd className="font-bold tabular-nums text-ink-900 dark:text-ink-50">{formatCents(weight.cost)}</dd>
      </div>
    </dl>
  );
}

/// How bids are compared, in plain words, behind an info button -- with
/// whatever working goes with it (`children`).
export function HowBidsCompare({ children }: { children?: ReactNode }) {
  const t = useT();
  const terms = useTerms();
  const vars = { each: formatCents(terms.minute_value_cents), clean: terms.clean_start_deliveries };
  const sections = (["rule", "time", "record", "choice"] as const).map((part) => ({ title: t(`bidWeight.why.${part}`), body: t(`bidWeight.why.${part}Detail`, vars) }));
  return (
    <InfoSheet title={t("bidWeight.how")} sections={sections}>
      {children}
    </InfoSheet>
  );
}
