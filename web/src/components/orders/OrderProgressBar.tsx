import clsx from "clsx";
import { motion } from "framer-motion";
import type { OrderProgress, OrderTone } from "../../lib/orders/progress";

const FILLS: Record<OrderTone, string> = {
  moving: "bg-handshake-500",
  needsYou: "bg-amber-500",
  arrived: "bg-presence-500",
  stopped: "bg-ink-300 dark:bg-ink-600",
  quiet: "bg-ink-300 dark:bg-ink-600",
};

/// An order's path as segments: those done filled, the one under way glowing.
/// For reading along only: the words beside it say where the order is.
export function OrderProgressBar({ progress, className }: { progress: OrderProgress; className?: string }) {
  const { steps, done, tone } = progress;
  return (
    <div aria-hidden className={clsx("flex gap-1", className)}>
      {Array.from({ length: steps }, (_, i) => (
        <span key={i} className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
          {i < done && <motion.span initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }} className={clsx("absolute inset-0 origin-left rounded-full", FILLS[tone])} />}
          {i === done && (tone === "moving" || tone === "needsYou") && <span className={clsx("absolute inset-0 rounded-full opacity-60 motion-safe:animate-pulse", FILLS[tone])} />}
        </span>
      ))}
    </div>
  );
}
