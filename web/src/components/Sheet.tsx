// A sheet: on a phone it slides up from the bottom over a dimmed page; on a
// tablet or wider it opens as a dialog in the middle. It closes on the
// backdrop, the close button or Escape. Content scrolls; `footer` stays
// pinned below it for the sheet's primary action. Drawn at the end of the
// page, so no screen's own layout or animation can move it.
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useTabletUp } from "../lib/hooks/useMediaQuery";
import { t as translate } from "../i18n";

const SLIDE = { hidden: { y: "100%" }, shown: { y: 0 } };
const POP = { hidden: { opacity: 0, scale: 0.96, y: 8 }, shown: { opacity: 1, scale: 1, y: 0 } };

export function Sheet({ open, onClose, title, subtitle, children, footer }: { open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  const dialog = useTabletUp();
  const motionOf = dialog ? POP : SLIDE;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-[2px] md:items-center md:p-6"
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            // Focus lands in the sheet, so Escape reaches it.
            ref={(node) => node?.focus()}
            tabIndex={-1}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            initial={motionOf.hidden}
            animate={motionOf.shown}
            exit={motionOf.hidden}
            transition={dialog ? { duration: 0.18, ease: [0.22, 1, 0.36, 1] } : { type: "spring", damping: 30, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none md:max-h-[85dvh] md:max-w-lg md:rounded-3xl dark:bg-ink-900"
          >
            <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-ink-200 md:hidden dark:bg-ink-700" />
            <div className="flex items-start justify-between gap-3 px-5 pt-3 pb-1 md:pt-5">
              <div>
                <h2 className="text-lg font-black tracking-tight text-ink-900 dark:text-ink-50">{title}</h2>
                {subtitle && <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-400">{subtitle}</p>}
              </div>
              <button onClick={onClose} aria-label={translate("common.close")} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-500 transition hover:bg-ink-200 dark:bg-ink-800 dark:hover:bg-ink-700">
                <X size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-5">{children}</div>
            {footer && <div className="border-t border-ink-100 px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] dark:border-ink-800">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
