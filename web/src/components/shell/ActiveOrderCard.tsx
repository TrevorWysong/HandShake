// The customer's orders in progress, always in the same place wherever they are
// in the app: above the bottom bar on a phone, in the sidebar on a wide screen.
// The one most in need of them leads; the rest are a tap away on the Orders tab.
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, X } from "lucide-react";
import clsx from "clsx";
import { useActiveOrders } from "../../store/activeOrders";
import type { CardOrder } from "../../lib/hooks/useCardOrders";
import { customerOrderPath } from "../../lib/orders/orderEntries";
import { customerProgress, orderEstimate, type OrderTone } from "../../lib/orders/progress";
import { useClock } from "../../lib/hooks/useClock";
import { formatClockTime } from "../../lib/ui/format";
import { useT } from "../../i18n";
import { OrderProgressBar } from "../orders/OrderProgressBar";
import { OrderToneIcon } from "../orders/OrderHero";

const OUTLINES: Record<OrderTone, string> = {
  moving: "border-ink-100 dark:border-ink-700",
  needsYou: "border-amber-400 dark:border-amber-600",
  arrived: "border-presence-300 dark:border-presence-700",
  stopped: "border-ink-200 dark:border-ink-700",
  quiet: "border-ink-100 dark:border-ink-700",
};

export function ActiveOrderCard({ cards, className }: { cards: CardOrder[]; className?: string }) {
  const t = useT();
  const dismiss = useActiveOrders((s) => s.dismissFinished);
  const lead = cards[0];
  return (
    <AnimatePresence>
      {lead && <motion.div key="active-order" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }} className={clsx("pointer-events-auto relative", className)}>
        <LeadCard card={lead} />
        {lead.finished && (
          <button type="button" onClick={() => dismiss(lead.order.row.hex)} aria-label={t("progress.dismiss")} className="absolute top-2 right-2 grid h-7 w-7 place-items-center rounded-full text-ink-400 transition hover:bg-ink-100 hover:text-ink-700 dark:hover:bg-ink-800 dark:hover:text-ink-200">
            <X size={14} />
          </button>
        )}
        {cards.length > 1 && (
          <Link to="/customer/orders" className="absolute -top-2.5 right-3 rounded-full bg-ink-900 px-2.5 py-0.5 text-[11px] font-bold text-white shadow-sm transition-colors hover:bg-ink-700 dark:bg-ink-100 dark:text-ink-900 dark:hover:bg-white">
            {t("progress.more", { count: cards.length - 1 })}
          </Link>
        )}
      </motion.div>}
    </AnimatePresence>
  );
}

function LeadCard({ card }: { card: CardOrder }) {
  const t = useT();
  const { row, storeName, need, driverDueAt } = card.order;
  const progress = customerProgress(row, need);
  const now = useClock();
  const estimate = orderEstimate(row, driverDueAt, now.getTime() * 1000);
  const detail = estimate ? t(estimate.kind === "arriving" ? "progress.arriving" : "progress.ready", { time: formatClockTime(estimate.at) }) : null;
  return (
    <Link to={customerOrderPath(row)} aria-label={[t(progress.headline), storeName, detail].filter(Boolean).join(". ")} className={clsx("block rounded-2xl border bg-white p-3 shadow-[var(--shadow-float)] transition-transform active:scale-[0.99] dark:bg-ink-900", OUTLINES[progress.tone])}>
      <span className="flex items-center gap-3">
        <OrderToneIcon tone={progress.tone} size={16} className="h-9 w-9" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-ink-900 dark:text-ink-50">{t(progress.headline)}</span>
          <span className="block truncate text-xs text-ink-500 dark:text-ink-400">{[storeName, detail].filter(Boolean).join(" · ")}</span>
        </span>
        {!card.finished && <ChevronRight size={16} className="shrink-0 text-ink-300" />}
      </span>
      <OrderProgressBar progress={progress} className="mt-2.5" />
    </Link>
  );
}
