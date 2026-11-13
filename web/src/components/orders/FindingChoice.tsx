// A store's finding with its answer to a report (docs/REPUTATION.md):
// declining one about items, that it wasn't made in good faith; refunding
// one about the delivery, that the driver was at fault. Never the default,
// always with a reason from a fixed list, and with what follows said
// plainly before it's made.
import { AnimatePresence, motion } from "framer-motion";
import { ShieldAlert } from "lucide-react";
import type { BadFaithReason, FaultReason, Finding } from "../../holochain/types";
import { BAD_FAITH_LABEL, BAD_FAITH_REASONS, FAULT_LABEL, FAULT_REASONS } from "../../lib/reputation/findings";
import { Chip, Switch } from "../ui";
import { useT, type MessageKey } from "../../i18n";

/// Which finding fits an answer: on a declined report about items, bad
/// faith; on a refunded report about the delivery, the driver at fault --
/// and that only when the customer said what went wrong, so the driver has
/// something to answer.
export type FindingKind = "badFaith" | "driverAtFault";

export function FindingChoice({ kind, finding, onChange, unavailable }: { kind: FindingKind; finding: Finding | null; onChange: (finding: Finding | null) => void; unavailable?: MessageKey }) {
  const t = useT();
  const on = finding !== null;
  const copy = kind === "badFaith"
    ? { label: "findingChoice.badFaith", detail: "findingChoice.badFaithDetail", warning: "findingChoice.badFaithWarning" } as const
    : { label: "findingChoice.fault", detail: "findingChoice.faultDetail", warning: "findingChoice.faultWarning" } as const;
  const first: Finding = kind === "badFaith" ? { BadFaith: BAD_FAITH_REASONS[0] } : { DriverAtFault: FAULT_REASONS[0] };
  return (
    <div className="mt-3 border-t border-ink-100 pt-3 dark:border-ink-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex min-w-0 flex-[1_1_12rem] items-center gap-2">
          <ShieldAlert size={16} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-ink-700 dark:text-ink-200">{t(copy.label)}</span>
            <span className="block text-[0.6875rem] text-ink-400">{t(unavailable ?? copy.detail)}</span>
          </span>
        </span>
        <Switch checked={on} disabled={!!unavailable} onChange={(next) => onChange(next ? first : null)} label={t(copy.label)} />
      </div>
      <AnimatePresence initial={false}>
        {on && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("findingChoice.why")}>
              {kind === "badFaith"
                ? BAD_FAITH_REASONS.map((reason: BadFaithReason) => (
                    <Chip key={reason} active={"BadFaith" in finding && finding.BadFaith === reason} onClick={() => onChange({ BadFaith: reason })}>{t(BAD_FAITH_LABEL[reason])}</Chip>
                  ))
                : FAULT_REASONS.map((reason: FaultReason) => (
                    <Chip key={reason} active={"DriverAtFault" in finding && finding.DriverAtFault === reason} onClick={() => onChange({ DriverAtFault: reason })}>{t(FAULT_LABEL[reason])}</Chip>
                  ))}
            </div>
            <p className="mt-2 rounded-xl bg-amber-50 p-2.5 text-[0.6875rem] leading-relaxed text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">{t(copy.warning)}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
