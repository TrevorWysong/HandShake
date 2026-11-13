// A driver's settings card: a title and a line saying where things stand,
// opening onto the settings themselves.
import { useState, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Card } from "../../components/ui";

export function SettingsCard({ icon: Icon, title, summary, children }: { icon: LucideIcon; title: string; summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="mb-5 p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={open}>
        <span className="flex min-w-0 items-center gap-2">
          <Icon size={16} className="shrink-0 text-ink-400" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink-900 dark:text-ink-50">{title}</span>
            <span className="block text-xs text-ink-400">{summary}</span>
          </span>
        </span>
        <ChevronDown size={16} className={`shrink-0 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mt-4 flex flex-col gap-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}
