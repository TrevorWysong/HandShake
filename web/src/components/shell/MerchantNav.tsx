import { NavLink, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, BellRing, ClipboardList, Store, Tag, UtensilsCrossed } from "lucide-react";
import { useMyStores } from "../../store/merchantStores";
import { awaitsAnswer, fetchActiveQueue, storesKey } from "../../store/merchantQueue";
import { isDisputed, useMerchantIssues } from "../../store/merchantIssues";
import { usePolling, useResource } from "../../lib/hooks/useResource";
import { useTerms } from "../../store/network";
import clsx from "clsx";
import { NavItem, type NavPlacement } from "./NavItem";
import { POLL, isOrderSignal } from "../../lib/network/poll";
import { useT } from "../../i18n";
import { PROMO_PAGES } from "../../routes/merchant/promoPages";

/// The store side's navigation, and its alert for what's waiting on it: a
/// badge on Orders, and -- on any other screen -- a banner (above the bottom
/// bar, or atop the sidebar), since an order not accepted within its window is
/// cancelled, and a report not answered in time is refunded. New orders come
/// first: they have the shorter clock. Re-read on every signal saying there's
/// more, and polled in case one was missed.
export function MerchantNav({ placement }: { placement: NavPlacement }) {
  const stores = useMyStores();
  const t = useT();
  const terms = useTerms();
  const windowSecs = terms.store_response_secs;
  const { pathname } = useLocation();
  const { data } = useResource(
    stores && stores.length > 0 ? `merchant-waiting:${storesKey(stores)}` : null,
    async () => ({ rows: await fetchActiveQueue(stores ?? []), now: Date.now() }),
    { pollMs: POLL.signalled, refreshOn: isOrderSignal },
  );
  const waiting = data ? data.rows.filter((row) => awaitsAnswer(row, windowSecs, data.now)).length : 0;
  const onQueue = pathname === "/merchant";

  const { reports = [], appeals, refresh } = useMerchantIssues();
  const hasStores = !!stores && stores.length > 0;
  usePolling(() => refresh(stores ?? [], terms.appeals).catch(() => undefined), { pollMs: POLL.slow, refreshOn: (signal) => "IssueReported" in signal }, hasStores, hasStores ? storesKey(stores) : null);
  const issues = (data?.rows.filter(isDisputed).length ?? 0) + reports.length + appeals.length;
  const banner = placement === "bar" ? "px-4 py-3 text-sm" : "flex-wrap px-3 py-2.5 text-xs";
  const bannerAt = placement === "bar" ? "absolute inset-x-2 bottom-full mb-2" : "mb-2";

  return (
    <>
      <AnimatePresence>
        {waiting > 0 && !onQueue && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className={bannerAt}
          >
            <NavLink to="/merchant" className={clsx("flex items-center gap-3 rounded-2xl bg-handshake-500 font-semibold text-white shadow-[var(--shadow-glow)]", banner)}>
              <BellRing size={18} className="animate-pulse" />
              {t("merchantNav.waiting", { count: waiting })}
              <span className="ml-auto text-xs font-bold uppercase tracking-wide">{t("merchantNav.review")}</span>
            </NavLink>
          </motion.div>
        )}
        {waiting === 0 && issues > 0 && !onQueue && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} className={bannerAt}>
            <NavLink to="/merchant?tab=issues" className={clsx("flex items-center gap-3 rounded-2xl bg-amber-500 font-semibold text-ink-950 shadow-[var(--shadow-card)]", banner)}>
              <AlertTriangle size={18} className="shrink-0" />
              {t("merchantNav.issues", { count: issues })}
              <span className="ml-auto text-xs font-bold uppercase tracking-wide">{t("merchantNav.review")}</span>
            </NavLink>
          </motion.div>
        )}
      </AnimatePresence>
      <NavItem to="/merchant" icon={ClipboardList} label={t("nav.orders")} badge={waiting + issues} placement={placement} />
      <NavItem to="/merchant/menu" icon={UtensilsCrossed} label={t("nav.menu")} placement={placement} />
      <NavItem to={PROMO_PAGES[0]} also={PROMO_PAGES} icon={Tag} label={t("nav.promos")} placement={placement} />
      <NavItem to="/merchant/store" icon={Store} label={t("nav.store")} placement={placement} />
    </>
  );
}
