import { ArrowDownCircle, ArrowUpCircle, CircleSlash, Clock, ShieldCheck } from "lucide-react";
import { TimeAgo } from "../components/TimeAgo";
import { motion } from "framer-motion";
import { useSession } from "../store/session";
import { myPaymentHistory } from "../holochain/zomes/payments";
import { bytesToHex } from "../holochain/decode";
import { Card, Skeleton, StatNumber } from "../components/ui";
import { formatCents } from "../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../lib/ui/motion";
import { useResource } from "../lib/hooks/useResource";
import { describePayment } from "../lib/money/payments";
import { useT } from "../i18n";

/// How far back the page reads.
const HISTORY_DAYS = 90;

/// The "no-skim" transparency dashboard: every payment this agent made or
/// received, newest first -- each held on the card of whoever paid, by
/// whoever it paid, and captured only for what the network says they're
/// owed. Every one is a signed record its order's parties can check. There
/// is no operator account anywhere in this system for a platform cut to go
/// to: each payment goes straight to the party it pays.
export function Transparency() {
  const t = useT();
  const agentPubKey = useSession((s) => s.agentPubKey);
  const agentHex = agentPubKey ? bytesToHex(agentPubKey) : null;
  const { data: items } = useResource(agentHex && `payment-history:${agentHex}`, () => myPaymentHistory(HISTORY_DAYS).catch(() => []));

  if (!agentPubKey || items === undefined) {
    return (
      <div className="px-4 pb-10 pt-4">
        <Skeleton className="h-44 w-full rounded-3xl mb-5" />
        <div className="mb-5 grid grid-cols-3 gap-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
        <Skeleton className="h-24 w-full mb-3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const rows = items.map((item) => ({ item, ...describePayment(item, agentPubKey) }));
  const settled = rows.filter((r) => !r.pending && !r.released);
  const totalReceived = settled.filter((r) => r.direction === "in").reduce((sum, r) => sum + r.amount, 0);
  const totalPaid = settled.filter((r) => r.direction === "out").reduce((sum, r) => sum + r.amount, 0);
  const net = totalReceived - totalPaid;
  const flowTotal = totalReceived + totalPaid;
  const receivedShare = flowTotal > 0 ? (totalReceived / flowTotal) * 100 : 50;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div
        variants={fadeSlideUp}
        className="relative mb-5 flex flex-col items-center gap-2 overflow-hidden rounded-3xl bg-gradient-to-br from-handshake-500 to-presence-500 p-6 text-center text-white shadow-[var(--shadow-float)]"
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 15%, rgba(255,255,255,0.25) 0%, transparent 45%), radial-gradient(circle at 85% 85%, rgba(255,255,255,0.15) 0%, transparent 40%)",
          }}
        />
        <motion.div animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }} className="relative">
          <ShieldCheck size={30} />
        </motion.div>
        <p className="relative text-4xl font-black tracking-tight">{formatCents(0)}</p>
        <p className="relative text-sm font-bold opacity-95">{t("transparency.zero")}</p>
        <p className="relative mt-1 max-w-xs text-xs leading-relaxed opacity-80">
          {t("transparency.detail")}
        </p>
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mb-2 grid grid-cols-3 gap-2">
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("transparency.received")}</p>
          <StatNumber tone="success" className="text-lg">{formatCents(totalReceived)}</StatNumber>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("transparency.paid")}</p>
          <StatNumber className="text-lg">{formatCents(totalPaid)}</StatNumber>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("transparency.net")}</p>
          <StatNumber tone={net > 0 ? "success" : "default"} className="text-lg">{formatCents(net)}</StatNumber>
        </Card>
      </motion.div>

      {flowTotal > 0 && (
        <motion.div variants={fadeSlideUp} className="mb-5">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${receivedShare}%` }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              className="bg-presence-500"
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] font-semibold text-ink-400">
            <span>{t("transparency.receivedShare", { percent: receivedShare.toFixed(0) })}</span>
            <span>{t("transparency.paidShare", { percent: (100 - receivedShare).toFixed(0) })}</span>
          </div>
        </motion.div>
      )}

      <motion.h2 variants={fadeSlideUp} className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">
        {t("transparency.entries")}
      </motion.h2>
      {rows.length === 0 ? (
        <motion.p variants={fadeSlideUp} className="mb-6 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 text-center text-sm text-ink-400">
          {t("transparency.empty")}
        </motion.p>
      ) : (
        <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="pb-6">
          <Card className="flex flex-col gap-3 p-4">
            {rows.map(({ item, label, direction, amount, pending, released }) => {
              const Icon = pending ? Clock : released ? CircleSlash : direction === "in" ? ArrowDownCircle : ArrowUpCircle;
              const earned = !pending && !released && direction === "in";
              return (
                <motion.div variants={fadeSlideUp} key={bytesToHex(item.hold)} className="flex items-center gap-3">
                  <Icon size={18} className={earned ? "shrink-0 text-presence-600" : "shrink-0 text-ink-400"} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">
                      {label}
                      {item.store_name && <span className="font-normal text-ink-500"> · {item.store_name}</span>}
                    </p>
                    <p className="text-xs text-ink-400">
                      <TimeAgo at={item.at} />
                      {pending && ` · ${t("transparency.held")}`}
                      {released && ` · ${t("transparency.released")}`}
                    </p>
                  </div>
                  {released ? (
                    <span className="shrink-0 text-sm tabular-nums text-ink-400 line-through">{formatCents(amount)}</span>
                  ) : (
                    <StatNumber tone={earned ? "success" : "default"} className="shrink-0 text-sm">
                      {direction === "in" ? "+" : "−"}
                      {formatCents(amount)}
                    </StatNumber>
                  )}
                </motion.div>
              );
            })}
          </Card>
        </motion.div>
      )}
    </motion.div>
  );
}
