// The top of an order's page: where it stands, large, and when it's due. The
// full list of steps opens under it, already open when an order's stopped or
// stuck, since that's where it says why.
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Bike, Check, ChevronDown, Clock, XCircle } from "lucide-react";
import clsx from "clsx";
import type { OrderEstimate, OrderProgress, OrderTone } from "../../lib/orders/progress";
import { useClock } from "../../lib/hooks/useClock";
import { formatClockTime } from "../../lib/ui/format";
import { useT } from "../../i18n";
import { InfoSheet } from "../InfoSheet";
import { OrderProgressBar } from "./OrderProgressBar";

const SURFACES: Record<OrderTone, string> = {
  moving: "border-handshake-200 bg-gradient-to-br from-handshake-50 to-white dark:border-handshake-500/30 dark:from-handshake-500/15 dark:to-ink-900",
  needsYou: "border-amber-300 bg-gradient-to-br from-amber-50 to-white dark:border-amber-500/40 dark:from-amber-500/15 dark:to-ink-900",
  arrived: "border-presence-500/40 bg-gradient-to-br from-presence-500/10 to-white dark:border-presence-500/30 dark:from-presence-500/15 dark:to-ink-900",
  stopped: "border-ink-200 bg-white dark:border-ink-800 dark:bg-ink-900",
  quiet: "border-ink-200 bg-white dark:border-ink-800 dark:bg-ink-900",
};

const ICONS: Record<OrderTone, { icon: typeof Bike; tint: string }> = {
  moving: { icon: Bike, tint: "bg-handshake-500 text-white" },
  needsYou: { icon: AlertTriangle, tint: "bg-amber-500 text-white" },
  arrived: { icon: Check, tint: "bg-presence-500 text-white" },
  stopped: { icon: XCircle, tint: "bg-ink-200 text-ink-600 dark:bg-ink-700 dark:text-ink-200" },
  quiet: { icon: Clock, tint: "bg-ink-200 text-ink-600 dark:bg-ink-700 dark:text-ink-200" },
};

export function OrderToneIcon({ tone, size = 20, className }: { tone: OrderTone; size?: number; className?: string }) {
  const { icon: Icon, tint } = ICONS[tone];
  return (
    <span className={clsx("grid shrink-0 place-items-center rounded-full", tint, className)}>
      <Icon size={size} />
    </span>
  );
}

/// When it's due, in words, with how that's worked out a tap away. Reads the
/// clock so an estimate that's passed goes rather than sitting there wrong.
export function OrderEstimateLine({ estimate }: { estimate: OrderEstimate }) {
  const t = useT();
  const now = useClock();
  if (estimate.at <= now.getTime() * 1000) return null;
  const sections = (["from", "not", "late"] as const).map((part) => ({ title: t(`progress.estimate.${part}`), body: t(`progress.estimate.${part}Detail`) }));
  return (
    <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-ink-700 dark:text-ink-200">
      <Clock size={14} className="text-ink-400" />
      {t(estimate.kind === "arriving" ? "progress.arriving" : "progress.ready", { time: formatClockTime(estimate.at) })}
      <InfoSheet title={t("progress.estimate.how")} sections={sections} />
    </p>
  );
}

export function OrderHero({ progress, eyebrow, estimate = null, chips, children }: { progress: OrderProgress; eyebrow?: ReactNode; estimate?: OrderEstimate | null; chips?: ReactNode; children?: ReactNode }) {
  const t = useT();
  const { tone, headline } = progress;
  // Open whenever the steps are where it says why, as an order comes to that;
  // a person who's opened or closed it keeps that, whatever happens next.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (tone === "stopped" || tone === "needsYou");
  return (
    <section className={clsx("rounded-3xl border p-4 shadow-[var(--shadow-card)] md:p-5", SURFACES[tone])}>
      <div className="flex items-start gap-3">
        <OrderToneIcon tone={tone} className="h-11 w-11" />
        <div className="min-w-0 flex-1">
          {eyebrow && <div className="truncate text-xs font-semibold text-ink-500 dark:text-ink-400">{eyebrow}</div>}
          <h1 role="status" className="text-xl font-black leading-tight tracking-tight text-ink-900 md:text-2xl dark:text-ink-50">{t(headline)}</h1>
          {estimate && <OrderEstimateLine estimate={estimate} />}
        </div>
        {chips}
      </div>
      <OrderProgressBar progress={progress} className="mt-4" />
      {children && (
        <>
          <button type="button" onClick={() => setChosen(!open)} aria-expanded={open} className="mt-3 flex w-full items-center justify-between rounded-lg py-1 text-xs font-semibold text-ink-500 transition-colors hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-100">
            {t("progress.allSteps")}
            <ChevronDown size={15} className={clsx("transition-transform", open && "rotate-180")} />
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="pt-3">{children}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </section>
  );
}
