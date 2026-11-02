import type { ReactNode } from "react";
import clsx from "clsx";

/// How wide a screen grows in a wide window: grids and boards to the whole
/// width, stacks of cards (an editor, a dashboard) to a middle width, and
/// forms and documents to a reading width. On a phone or tablet every
/// screen fills the column.
export type ScreenWidth = "wide" | "medium" | "reading";

const WIDTHS: Record<ScreenWidth, string> = {
  wide: "lg:max-w-6xl",
  medium: "lg:max-w-4xl",
  reading: "lg:max-w-2xl",
};

/// A route's screen, at its width -- named beside the route (`App.tsx`).
export function Screen({ width, children }: { width: ScreenWidth; children: ReactNode }) {
  return <div className={clsx("lg:mx-auto lg:w-full", WIDTHS[width])}>{children}</div>;
}
