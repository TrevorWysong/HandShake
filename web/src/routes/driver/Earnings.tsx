import { ShieldCheck } from "lucide-react";
import { motion } from "framer-motion";
import { getReputationSummary } from "../../holochain/zomes/reputation";
import { myAgentPubKey } from "../../holochain/client";
import { bytesToHex } from "../../holochain/decode";
import { useResource } from "../../lib/hooks/useResource";
import { Card, Skeleton, StatNumber } from "../../components/ui";
import { GettingPaidCard } from "../../components/payments/GettingPaidCard";
import { InfoSheet } from "../../components/InfoSheet";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { EarningsReport } from "./EarningsReport";
import { useT } from "../../i18n";
import { useTerms } from "../../store/network";

export function Earnings() {
  const t = useT();
  const terms = useTerms();
  const me = myAgentPubKey();
  const meHex = bytesToHex(me);
  // Driver-scoped: deliveries only, never completions at a store this
  // agent might also run.
  const { data: rep } = useResource(`driver-rep:${meHex}`, () => getReputationSummary({ Driver: me }));

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4 pb-8">
      <motion.h1 variants={fadeSlideUp} className="mb-4 text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        {t("nav.earnings")}
      </motion.h1>

      <motion.div variants={fadeSlideUp}>
        {/* Where the money goes: straight to their own processor account. */}
        <GettingPaidCard className="mb-4" />
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <EarningsReport meHex={meHex} />
      </motion.div>

      <motion.p variants={fadeSlideUp} className="mb-4 rounded-xl bg-ink-100/60 dark:bg-ink-800/60 px-4 py-3 text-xs text-ink-500 dark:text-ink-400">
        {t("earnings.note")}
      </motion.p>

      <motion.div variants={fadeSlideUp}>
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-1">
            <p className="flex items-center gap-2 text-sm font-bold text-ink-900 dark:text-ink-50">
              <ShieldCheck size={16} className="text-presence-600" /> {t("earnings.reputation")}
            </p>
            <InfoSheet title={t("earnings.repHow")} sections={(["counts", "matching", "seen", "fair"] as const).map((part) => ({ title: t(`earnings.rep.${part}`), body: t(`earnings.rep.${part}Detail`, { clean: terms.clean_start_deliveries }) }))} />
          </div>
          <p className="-mt-2 mb-3 text-xs text-ink-400">{t("reputation.window", { count: terms.reputation_window_days })}</p>
          {rep === undefined ? (
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : (
            <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="grid grid-cols-2 gap-3 text-sm">
              <Stat label={t("earnings.completed")} value={rep.completed_count} tone="success" />
              <Stat label={t("earnings.dropped")} value={rep.dropped_count} tone={rep.dropped_count > 0 ? "danger" : "default"} />
              <Stat label={t("earnings.disputes")} value={rep.dispute_raised_count} />
              <Stat label={t("earnings.against")} value={rep.dispute_resolved_against_count} tone={rep.dispute_resolved_against_count > 0 ? "danger" : "default"} />
            </motion.div>
          )}
        </Card>
      </motion.div>
    </motion.div>
  );
}

function Stat({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "success" | "danger" }) {
  return (
    <motion.div variants={fadeSlideUp} className="rounded-xl bg-ink-50 dark:bg-ink-800/60 p-3">
      <StatNumber tone={tone} className="text-lg">{value}</StatNumber>
      <p className="text-xs text-ink-400">{label}</p>
    </motion.div>
  );
}
