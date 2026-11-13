// A customer's record, where drivers and stores decide whether to take
// their order: their score from the stores and drivers who've served them
// (docs/REPUTATION.md, phase 4) -- shown once there are enough ratings, the
// reasons behind any thumbs-down counted, never who gave them -- and the
// orders they said never arrived when the store found they had, deliveries
// they weren't there to take, and orders they called off once the store had
// taken them on, or never came for. Public -- each cites its order.
import { ShieldAlert, ThumbsUp } from "lucide-react";
import { getCustomerScore, getReputationSummary } from "../../holochain/zomes/reputation";
import { bytesToHex } from "../../holochain/decode";
import type { CustomerScore } from "../../holochain/types";
import { useResource } from "../../lib/hooks/useResource";
import { POLL } from "../../lib/network/poll";
import { useT } from "../../i18n";
import { InfoSheet } from "../InfoSheet";
import { customerRecordLines } from "../../lib/reputation/recordLines";
import { CUSTOMER_REASON_LABEL, scorePercent } from "../../lib/reputation/customers";

export function CustomerHistory({ customer }: { customer: Uint8Array }) {
  const t = useT();
  const hex = bytesToHex(customer);
  const { data: summary } = useResource(`customer-history:${hex}`, () => getReputationSummary({ Customer: customer }), { pollMs: POLL.slow });
  const { data: score } = useResource(`customer-score:${hex}`, () => getCustomerScore(customer), { pollMs: POLL.slow });
  const lines = summary ? customerRecordLines(summary, t) : [];
  const percent = score ? scorePercent(score) : null;
  if (lines.length === 0 && percent === null) return null;
  const sections = (["what", "use", "score"] as const).map((part) => ({ title: t(`history.why.${part}`), body: t(`history.why.${part}Detail`) }));
  return (
    <div className="mt-1 flex items-start gap-1">
      <ul className="flex flex-col gap-0.5">
        {percent !== null && score && <ScoreLine score={score} percent={percent} />}
        {lines.map((line) => (
          <li key={line} className="flex items-center gap-1 text-[0.6875rem] font-semibold text-amber-700 dark:text-amber-300">
            <ShieldAlert size={12} className="shrink-0" aria-hidden />
            {line}
          </li>
        ))}
      </ul>
      <InfoSheet title={t("history.how")} sections={sections} />
    </div>
  );
}

/// "92% thumbs-up from 40 ratings", and the reasons behind any thumbs-down.
export function ScoreLine({ score, percent }: { score: CustomerScore; percent: number }) {
  const t = useT();
  const reasons = [...score.reasons].sort((a, b) => b[1] - a[1]).map(([reason, count]) => t("score.reasonCount", { reason: t(CUSTOMER_REASON_LABEL[reason]), count }));
  return (
    <li className="text-[0.6875rem] text-ink-600 dark:text-ink-300">
      <span className="flex items-center gap-1 font-semibold">
        <ThumbsUp size={12} className="shrink-0" aria-hidden />
        {t("score.line", { percent, count: score.up + score.down })}
      </span>
      {reasons.length > 0 && <span className="block pl-4 text-ink-500 dark:text-ink-400">{reasons.join(" · ")}</span>}
    </li>
  );
}
