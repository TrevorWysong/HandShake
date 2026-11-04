// A customer's record, where drivers and stores decide whether to take
// their order: orders they said never arrived when the store found they
// had, deliveries they weren't there to take, and orders they called off
// once the store had taken them on, or never came for. Public -- each was
// recorded by that order's store, citing its decision or the order's own
// record.
import { ShieldAlert } from "lucide-react";
import { getReputationSummary } from "../../holochain/zomes/reputation";
import { bytesToHex } from "../../holochain/decode";
import { useResource } from "../../lib/hooks/useResource";
import { POLL } from "../../lib/network/poll";
import { useT } from "../../i18n";
import { InfoSheet } from "../InfoSheet";

export function CustomerHistory({ customer }: { customer: Uint8Array }) {
  const t = useT();
  const { data: summary } = useResource(`customer-history:${bytesToHex(customer)}`, () => getReputationSummary({ Customer: customer }), { pollMs: POLL.slow });
  if (!summary) return null;
  const lines = [
    summary.dispute_resolved_against_count > 0 && t("history.contested", { count: summary.dispute_resolved_against_count }),
    summary.no_show_count > 0 && t("history.noShows", { count: summary.no_show_count }),
    summary.cancelled_by_them_count > 0 && t("history.cancelled", { count: summary.cancelled_by_them_count }),
  ].filter((line): line is string => !!line);
  if (lines.length === 0) return null;
  const sections = (["what", "use"] as const).map((part) => ({ title: t(`history.why.${part}`), body: t(`history.why.${part}Detail`) }));
  return (
    <div className="mt-1 flex items-start gap-1">
      <ul className="flex flex-col gap-0.5">
        {lines.map((line) => (
          <li key={line} className="flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
            <ShieldAlert size={12} className="shrink-0" />
            {line}
          </li>
        ))}
      </ul>
      <InfoSheet title={t("history.how")} sections={sections} />
    </div>
  );
}
