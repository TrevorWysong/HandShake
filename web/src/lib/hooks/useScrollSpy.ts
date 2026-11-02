// Which of a page's sections is being read -- for a menu's category nav to
// mark where the reader is. The section crossing a band a fifth of the way
// down the window wins; the first, before any has.
import { useMemo, useSyncExternalStore } from "react";

export function useScrollSpy(ids: string[]): string | null {
  const key = ids.join("\n");
  const spy = useMemo(() => watch(key ? key.split("\n") : []), [key]);
  return useSyncExternalStore(spy.subscribe, spy.current, () => null);
}

function watch(ids: string[]) {
  let active = ids[0] ?? null;
  return {
    current: () => active,
    subscribe(changed: () => void) {
      const crossing = new Set<string>();
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) crossing.add(entry.target.id);
            else crossing.delete(entry.target.id);
          }
          const next = ids.find((id) => crossing.has(id)) ?? active;
          if (next !== active) {
            active = next;
            changed();
          }
        },
        { rootMargin: "-20% 0px -75% 0px" },
      );
      for (const id of ids) {
        const section = document.getElementById(id);
        if (section) observer.observe(section);
      }
      return () => observer.disconnect();
    },
  };
}
