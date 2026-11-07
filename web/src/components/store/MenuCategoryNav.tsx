import clsx from "clsx";
import { useScrollSpy } from "../../lib/hooks/useScrollSpy";

export interface MenuCategory {
  /// The section's element id, to scroll to and watch.
  id: string;
  name: string;
}

function goTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/// A menu's categories, marking the one being read: a bar of chips that
/// sticks under the header on a phone or tablet, a list that sticks beside
/// the menu on a wide screen.
export function MenuCategoryNav({ categories, placement, label, className }: { categories: MenuCategory[]; placement: "bar" | "side"; label: string; className?: string }) {
  const active = useScrollSpy(categories.map((c) => c.id));
  if (placement === "side") {
    return (
      <nav aria-label={label} className={clsx("sticky top-6 flex flex-col gap-0.5", className)}>
        <p className="mb-2 px-3 text-[11px] font-bold tracking-wide text-ink-400 uppercase">{label}</p>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => goTo(c.id)}
            aria-current={active === c.id ? "true" : undefined}
            className={clsx(
              "truncate rounded-xl px-3 py-2 text-left text-sm font-semibold transition",
              active === c.id ? "bg-white text-ink-900 shadow-sm dark:bg-ink-900 dark:text-white" : "text-ink-500 hover:bg-ink-100 hover:text-ink-900 dark:hover:bg-ink-800 dark:hover:text-white",
            )}
          >
            {c.name}
          </button>
        ))}
      </nav>
    );
  }
  return (
    <nav aria-label={label} className={clsx("no-scrollbar sticky top-header z-10 -mx-4 flex gap-1.5 overflow-x-auto border-b border-ink-100 bg-ink-50/95 px-4 py-2 backdrop-blur dark:border-ink-800 dark:bg-ink-950/95", className)}>
      {categories.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => goTo(c.id)}
          aria-current={active === c.id ? "true" : undefined}
          className={clsx(
            "shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition",
            active === c.id ? "bg-ink-900 text-white dark:bg-white dark:text-ink-900" : "text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800",
          )}
        >
          {c.name}
        </button>
      ))}
    </nav>
  );
}
