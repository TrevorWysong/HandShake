// Where `toast` shows: at the foot of the screen, above the tab bar on a
// phone, and read out by screen readers.
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";
import clsx from "clsx";
import { useToast } from "../../store/toast";

/// `lifted`: something else is floating above the tab bar, so it goes above that.
export function Toaster({ lifted = false }: { lifted?: boolean }) {
  const { message, id } = useToast();
  return (
    <div role="status" aria-live="polite" className={clsx("pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4 lg:bottom-8 lg:left-sidebar", lifted ? "bottom-[calc(11rem+env(safe-area-inset-bottom))]" : "bottom-[calc(5rem+env(safe-area-inset-bottom))]")}>
      <AnimatePresence>
        {message && (
          <motion.div
            key={id}
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2 }}
            className="flex items-center gap-2 rounded-full bg-ink-900 px-4 py-2.5 text-sm font-semibold text-white shadow-lg dark:bg-white dark:text-ink-900"
          >
            <CheckCircle2 size={16} className="text-presence-400 dark:text-presence-600" />
            {message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
