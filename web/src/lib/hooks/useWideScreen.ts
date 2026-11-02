// Whether the window is wide enough for the desktop layout -- Tailwind's
// `lg` (64rem), the breakpoint the shell's `lg:` classes switch at. Read
// for what's rendered once rather than styled twice: the navigation, which
// polls.
import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 64rem)";

function subscribe(changed: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
}

export function useWideScreen(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}
