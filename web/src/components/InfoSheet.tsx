// A subtle "i" that opens an explanation too long for a tooltip -- how
// something is worked out, or why it's done the way it is -- as titled
// sections in a sheet, with anything that goes with them (`children`):
// the working itself, say. More than a few sections fold to their titles, so
// the sheet reads as a list of questions. `InfoTip` is its one-sentence sibling.
import { useState, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { Sheet } from "./Sheet";

export interface InfoSection {
  title: string;
  body: string;
}

/// How many sections a sheet shows in full; past this, each folds to its title.
const FOLD_AFTER = 3;

export function InfoSheet({ title, sections, children }: { title: string; sections: InfoSection[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={title} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-400 transition hover:bg-ink-100 hover:text-ink-600 dark:hover:bg-ink-800 dark:hover:text-ink-200">
        <Info size={14} />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={title}>
        {sections.length > FOLD_AFTER ? (
          <div className="flex flex-col pb-2">
            <div className="divide-y divide-ink-100 dark:divide-ink-800">
              {sections.map((section) => (
                <details key={section.title} className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 text-sm font-bold text-ink-900 dark:text-ink-50 [&::-webkit-details-marker]:hidden">
                    {section.title}
                    <ChevronDown size={16} aria-hidden className="shrink-0 text-ink-400 transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="pb-3 text-sm leading-relaxed text-ink-600 dark:text-ink-300">{section.body}</p>
                </details>
              ))}
            </div>
            {children && <div className="mt-4">{children}</div>}
          </div>
        ) : (
          <div className="flex flex-col gap-4 pb-2">
            {sections.map((section) => (
              <section key={section.title}>
                <h3 className="text-sm font-bold text-ink-900 dark:text-ink-50">{section.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-600 dark:text-ink-300">{section.body}</p>
              </section>
            ))}
            {children}
          </div>
        )}
      </Sheet>
    </>
  );
}
