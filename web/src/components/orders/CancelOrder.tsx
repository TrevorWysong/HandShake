// Cancelling an order, asked once more: a stray tap shouldn't lose it.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { Button } from "../ui";
import { useT } from "../../i18n";

export function CancelOrder({ cancelling, disabled = false, onCancel, className }: { cancelling: boolean; disabled?: boolean; onCancel: () => void; className?: string }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  return (
    <AnimatePresence mode="wait" initial={false}>
      {asking ? (
        <motion.div key="ask" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={clsx("rounded-xl border border-ink-200 p-3 dark:border-ink-700", className)}>
          <p className="text-xs font-semibold text-ink-700 dark:text-ink-200">{t("order.cancelAsk")}</p>
          <div className="mt-2 flex gap-2">
            <Button variant="ghost" className="flex-1 py-2 text-xs" disabled={cancelling} onClick={() => setAsking(false)}>
              {t("order.keep")}
            </Button>
            <Button variant="danger" className="flex-1 py-2 text-xs" loading={cancelling} disabled={disabled} onClick={onCancel}>
              {t("order.cancel")}
            </Button>
          </div>
        </motion.div>
      ) : (
        <motion.div key="button" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={className}>
          <Button variant="ghost" className="w-full py-2 text-xs" disabled={disabled} onClick={() => setAsking(true)}>
            {t("order.cancel")}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
