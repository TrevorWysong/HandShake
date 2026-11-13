// A store's or driver's own threshold on customers' scores
// (docs/REPUTATION.md, phase 4): below it, the store's auto-accept holds an
// order for review, or the driver's automatic bidding passes it by. Off by
// default; a customer with no score shown yet is never below it.
import { Chip } from "../ui";
import { SCORE_THRESHOLDS } from "../../lib/reputation/customers";
import { useT } from "../../i18n";

export function ScoreThreshold({ label, detail, value, onChange, disabled }: { label: string; detail: string; value: number | null; onChange: (value: number | null) => void; disabled?: boolean }) {
  const t = useT();
  return (
    <div className="mt-3 border-t border-ink-100 pt-3 dark:border-ink-800">
      <p className="text-xs font-semibold text-ink-600 dark:text-ink-300">{label}</p>
      <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-ink-400">{detail}</p>
      <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        <Chip active={value === null} onClick={() => !disabled && onChange(null)}>{t("scoreThreshold.off")}</Chip>
        {SCORE_THRESHOLDS.map((percent) => (
          <Chip key={percent} active={value === percent} onClick={() => !disabled && onChange(percent)}>
            {t("scoreThreshold.below", { percent })}
          </Chip>
        ))}
      </div>
    </div>
  );
}
