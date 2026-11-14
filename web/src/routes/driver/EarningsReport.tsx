// A driver's earnings by week or month -- deliveries, fees, tips, what
// stores paid for keeping them waiting, collateral forfeited -- from their
// payment history, with a CSV for their records.
import { downloadText } from "../../lib/ui/download";
import { useState } from "react";
import { Download } from "lucide-react";
import { myPaymentHistory } from "../../holochain/zomes/payments";
import { hexToBytes } from "../../holochain/decode";
import { Card, SegmentedTabs, Skeleton } from "../../components/ui";
import { earned, earningsByPeriod, earningsCsv, periodStart, type Grouping } from "../../lib/driving/earnings";
import { formatCents, fromMinorUnits } from "../../lib/ui/format";
import { appLocale, useT } from "../../i18n";
import { useResource } from "../../lib/hooks/useResource";
import { useClock } from "../../lib/hooks/useClock";
import { describeError } from "../../lib/ui/errors";

/// A year of history: what a report by month needs.
const HISTORY_DAYS = 366;

export function EarningsReport({ meHex }: { meHex: string }) {
  const [grouping, setGrouping] = useState<Grouping>("week");
  const t = useT();
  const { data: items, error } = useResource(`payment-history:${meHex}`, () => myPaymentHistory(HISTORY_DAYS));
  const periods = items ? earningsByPeriod(items, hexToBytes(meHex), grouping).filter((p) => earned(p) + p.forfeited > 0) : undefined;
  // The headline: this week, whichever way the list below is grouped.
  const now = useClock();
  const thisWeekStart = periodStart(now.getTime(), "week");
  const thisWeek = items ? earningsByPeriod(items, hexToBytes(meHex), "week").find((p) => p.start === thisWeekStart) : undefined;
  const label = (start: number) =>
    grouping === "week"
      ? t("earnings.weekOf", { date: new Date(start).toLocaleDateString(appLocale(), { day: "numeric", month: "short" }) })
      : new Date(start).toLocaleDateString(appLocale(), { month: "long", year: "numeric" });

  function download() {
    if (!periods) return;
    downloadText(`handshake-earnings-by-${grouping}.csv`, earningsCsv(periods, grouping, (c) => fromMinorUnits(c).toFixed(2)));
  }

  return (
    <>
    {items && (
      <div className="mb-4 rounded-3xl bg-gradient-to-br from-handshake-500 to-handshake-700 p-5 text-white shadow-[var(--shadow-float)]">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/80">{t("earnings.thisWeek")}</p>
        <p className="mt-1 text-4xl font-black tracking-tight tabular-nums">{formatCents(thisWeek ? earned(thisWeek) : 0)}</p>
        <p className="mt-1 text-sm text-white/85">
          {thisWeek ? `${t("earnings.deliveries", { count: thisWeek.deliveries })} · ${t("earnings.tips", { amount: formatCents(thisWeek.tips) })}` : t("earnings.noneThisWeek")}
        </p>
      </div>
    )}
    <Card className="mb-4 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("nav.earnings")}</p>
        <SegmentedTabs label={t("nav.earnings")} tabs={[{ value: "week", label: t("earnings.weekly") }, { value: "month", label: t("earnings.monthly") }] as const} value={grouping} onChange={setGrouping} />
      </div>
      {periods === undefined ? (
        error ? <p className="text-sm text-red-600 dark:text-red-400">{describeError(error)}</p> : <Skeleton className="h-24" />
      ) : periods.length === 0 ? (
        <p className="text-sm text-ink-400">{t("earnings.empty")}</p>
      ) : (
        <>
          <ul className="divide-y divide-ink-100 dark:divide-ink-800">
            {periods.slice(0, 12).map((p) => (
              <li key={p.start} className="py-2.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-ink-800 dark:text-ink-100">{label(p.start)}</span>
                  <span className="text-sm font-black text-ink-900 dark:text-ink-50">{formatCents(earned(p))}</span>
                </div>
                <p className="text-xs text-ink-400">
                  {t("earnings.deliveries", { count: p.deliveries })} · {t("earnings.fees", { amount: formatCents(p.fees) })} · {t("earnings.tips", { amount: formatCents(p.tips) })}
                  {p.lateCover > 0 && ` · ${t("earnings.waiting", { amount: formatCents(p.lateCover) })}`}
                  {p.forfeited > 0 && ` · ${t("earnings.forfeited", { amount: formatCents(p.forfeited) })}`}
                </p>
              </li>
            ))}
          </ul>
          <button onClick={download} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-handshake-600 dark:text-handshake-400">
            <Download size={13} /> {t("earnings.csv")}
          </button>
        </>
      )}
    </Card>
    </>
  );
}
