// The window's title, as the screen's own name -- what a screen reader
// announces on arriving and a browser tab shows: "Orders · HandShake".
// Syncing with the document is what an effect is for.
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useT, type MessageKey } from "../../i18n";

const APP = "HandShake";

/// Each screen's name, by its path -- the first that matches.
const TITLES: [RegExp, MessageKey][] = [
  [/^\/customer\/cart\/[^/]+$/, "cart.title"],
  [/^\/customer\/cart$/, "carts.title"],
  [/^\/customer\/(pickup-)?orders(\/.+)?$/, "nav.orders"],
  [/^\/customer\/merchant\/[^/]+\/about$/, "store.info"],
  [/^\/customer\/merchant\//, "nav.store"],
  [/^\/customer\/?$/, "nav.browse"],
  [/^\/rewards/, "nav.rewards"],
  [/^\/driver\/earnings$/, "nav.earnings"],
  [/^\/driver\/?$/, "nav.dash"],
  [/^\/merchant\/menu$/, "nav.menu"],
  [/^\/merchant\/(promos|rewards)$/, "nav.promos"],
  [/^\/merchant\/store/, "nav.store"],
  [/^\/merchant\/?$/, "nav.orders"],
  [/^\/profile$/, "nav.profile"],
  [/^\/account$/, "profile.account"],
  [/^\/payments$/, "payments.title"],
  [/^\/policies$/, "policies.title"],
];

export function usePageTitle(): void {
  const t = useT();
  const { pathname } = useLocation();
  const key = TITLES.find(([path]) => path.test(pathname))?.[1];
  const title = key ? `${t(key)} · ${APP}` : APP;
  useEffect(() => {
    document.title = title;
  }, [title]);
}
