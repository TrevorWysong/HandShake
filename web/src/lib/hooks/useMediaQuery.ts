// Whether the window matches a media query, for what's rendered once
// rather than styled twice. The widths are Tailwind's breakpoints, the
// same ones the `md:` and `lg:` classes switch at.
import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/// A tablet or wider (`md`, 48rem): dialogs open centred, not as sheets.
export const useTabletUp = () => useMediaQuery("(min-width: 48rem)");

/// A wide screen (`lg`, 64rem): the shell's sidebar -- and its navigation,
/// which polls, rendered there and not in the bottom bar as well.
export const useWideScreen = () => useMediaQuery("(min-width: 64rem)");
