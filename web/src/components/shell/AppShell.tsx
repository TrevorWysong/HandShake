import { useEffect, useLayoutEffect, useMemo } from "react";
import { NavigationType, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { motion } from "framer-motion";
import clsx from "clsx";
import { Home, ClipboardList, ShoppingCart, User, Car, DollarSign, Gift } from "lucide-react";
import { useSession, type Mode } from "../../store/session";
import { useCart } from "../../store/cart";
import { pageVariants } from "../../lib/ui/motion";
import { bytesToHex } from "../../holochain/decode";
import { PresenceDot } from "../ui";
import { NavItem, type NavPlacement } from "./NavItem";
import { MerchantNav } from "./MerchantNav";
import { Notifier } from "./Notifier";
import { DriverFeed } from "./DriverFeed";
import { DriverDeliveries } from "./DriverDeliveries";
import { useDriverFeed } from "../../store/driverFeed";
import { Toaster } from "./Toaster";
import { ConnectionBanner } from "./ConnectionBanner";
import { ActiveOrderCard } from "./ActiveOrderCard";
import { CustomerDock } from "./CustomerDock";
import { dockFits, useCardOrders } from "../../lib/hooks/useCardOrders";
import { useActiveOrders } from "../../store/activeOrders";
import { useLatest, usePolling } from "../../lib/hooks/useResource";
import { POLL } from "../../lib/network/poll";
import { reaffirmRecoveryPlan } from "../../holochain/zomes/account";
import { useWideScreen } from "../../lib/hooks/useMediaQuery";
import { useT } from "../../i18n";


/// How far down each recent history entry was scrolled.
const SCROLLS_KEPT = 32;
const scrolledTo = new Map<string, number>();
// It's done here, so the browser's own restoring doesn't race it.
if (typeof history !== "undefined") history.scrollRestoration = "manual";

/// Goes to `y`, and keeps at it for a moment as a screen coming back fills in
/// beneath: until then its page may be too short to get there.
function scrollBack(y: number) {
  window.scrollTo(0, y);
  if (y === 0) return;
  const until = performance.now() + 1500;
  let last = window.scrollY;
  const settle = () => {
    // They've scrolled themselves: it's theirs now.
    if (window.scrollY !== last || window.scrollY === y || performance.now() > until) return;
    window.scrollTo(0, y);
    last = window.scrollY;
    requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}

/// Wraps whichever route is active in a short fade+rise, so navigating
/// between screens (Browse -> cart, an order's detail page, switching
/// modes) feels like one continuous app rather than a hard page swap. Only
/// the arriving screen animates: the one leaving goes at once, so no screen
/// can be left behind mid-exit -- invisible -- however it was left. Each
/// screen starts at its top, as a page does -- or, gone back to, where it
/// was left.
function AnimatedOutlet() {
  const location = useLocation();
  const navigationType = useNavigationType();
  // Read once as it's arrived at: arriving moves the page, which is recorded too.
  const backTo = useMemo(() => (navigationType === NavigationType.Pop ? (scrolledTo.get(location.key) ?? 0) : 0), [location.key, navigationType]);
  // Swapped in with the screen: a shorter screen arriving moves the page, and
  // that's not where the one leaving was left.
  useLayoutEffect(() => {
    const remember = () => {
      scrolledTo.delete(location.key);
      scrolledTo.set(location.key, window.scrollY);
      if (scrolledTo.size > SCROLLS_KEPT) scrolledTo.delete(scrolledTo.keys().next().value!);
    };
    window.addEventListener("scroll", remember, { passive: true });
    // Scroll events come a frame late, and a tap can leave before one does.
    document.addEventListener("click", remember, { capture: true });
    window.addEventListener("popstate", remember, { capture: true });
    return () => {
      window.removeEventListener("scroll", remember);
      document.removeEventListener("click", remember, { capture: true });
      window.removeEventListener("popstate", remember, { capture: true });
    };
  }, [location.key]);
  // As the screen arrives, not when its animation starts: that can come late on
  // a slow device, and undo a person who's already scrolled. By its path, so a
  // filter in the URL doesn't send it back to the top.
  const arrivedAt = useLatest(backTo);
  useLayoutEffect(() => scrollBack(arrivedAt.current), [location.pathname, arrivedAt]);
  return (
    <motion.div key={location.pathname} variants={pageVariants} initial="initial" animate="animate">
      <Outlet />
    </motion.div>
  );
}

export function AppShell() {
  const { mode: chosenMode, setMode, profile, agentPubKey } = useSession();
  const { pathname } = useLocation();
  const cartCount = useCart((s) => s.lines.reduce((n, l) => n + l.quantity, 0));
  const navigate = useNavigate();
  const wide = useWideScreen();
  const t = useT();
  const roles = profile?.roles ?? [];
  // Keeps the account's recovery plan close to where its chain stands, so a
  // recovery stays cheap to validate.
  usePolling(() => reaffirmRecoveryPlan().catch(() => false), { pollMs: POLL.upkeep, background: true }, !!agentPubKey);

  const availableModes = [
    roles.includes("Requester") && ("customer" as const),
    roles.includes("Provider") && ("driver" as const),
    roles.includes("Merchant") && ("merchant" as const),
  ].filter(Boolean) as Mode[];
  // A customer, driver or store page is that mode's, however it was reached
  // -- a notification's link, the back button -- so its nav is the one shown;
  // pages every mode shares (profile, account) keep the mode last used.
  const routeMode = MODES.find((m) => pathname === `/${m}` || pathname.startsWith(`/${m}/`));
  const mode = routeMode && availableModes.includes(routeMode) ? routeMode : chosenMode;
  // Their orders in progress follow a customer around the app.
  const owner = agentPubKey ? bytesToHex(agentPubKey) : null;
  // Online to drive, whichever mode they're in: their feed runs, and the
  // mode switch shows it.
  const driving = useDriverFeed((s) => !!owner && s.driver === owner);
  const refreshActiveOrders = useActiveOrders((s) => s.refresh);
  usePolling(() => owner && refreshActiveOrders(owner).catch(() => undefined), { pollMs: POLL.signalled, refreshOn: () => true }, mode === "customer" && !!owner, owner ?? undefined);
  const cards = useCardOrders(pathname, owner);
  const docked = mode === "customer" && dockFits(pathname);
  // Remember it, so those shared pages, and home, follow the mode last seen.
  useEffect(() => {
    if (mode !== chosenMode) setMode(mode);
  }, [mode, chosenMode, setMode]);

  function switchMode(next: Mode) {
    setMode(next);
    navigate(`/${next}`);
  }

  const modeSwitch = availableModes.length > 1 && (
    <div className="flex items-center rounded-full bg-ink-100 p-1 text-xs font-semibold dark:bg-ink-800">
      {availableModes.map((m) => (
        <button
          key={m}
          onClick={() => switchMode(m)}
          className={clsx(
            "flex flex-1 items-center justify-center gap-1.5 rounded-full px-2.5 py-1 capitalize transition",
            mode === m ? "bg-white text-ink-900 shadow-sm dark:bg-ink-950 dark:text-white" : "text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
          )}
        >
          {t(`mode.${m}`)}
          {m === "driver" && driving && (
            <span role="img" aria-label={t("drive.online")} className="inline-flex">
              <PresenceDot />
            </span>
          )}
        </button>
      ))}
    </div>
  );
  const brand = (
    <div className="flex items-center gap-2">
      <img src="favicon.svg" alt="" className="h-8 w-8 rounded-xl" />
      <span className="text-lg font-black tracking-tight">HandShake</span>
    </div>
  );

  return (
    <div className="min-h-svh bg-ink-50 lg:flex dark:bg-ink-950">
      {wide && (
        <aside className="sticky top-0 flex h-svh w-sidebar shrink-0 flex-col gap-6 border-r border-ink-100 bg-white px-4 py-5 dark:border-ink-800 dark:bg-ink-900">
          <div className="px-2">{brand}</div>
          {modeSwitch}
          <nav className="flex flex-col gap-1">
            <ModeNav mode={mode} cartCount={cartCount} placement="side" />
          </nav>
          <div className="mt-auto flex flex-col gap-1">
            {mode === "customer" && <ActiveOrderCard cards={cards} className="mb-3" />}
            <NavItem to="/profile" icon={User} label={t("nav.profile")} placement="side" />
            {agentPubKey && (
              <p className="flex items-center gap-2 px-3 pt-2 text-[11px] text-ink-400">
                <PresenceDot />
                {t("shell.connected")}
              </p>
            )}
          </div>
        </aside>
      )}

      {/* A phone's column, wider on a tablet; beside the sidebar on a wide screen. */}
      <div className="mx-auto flex min-h-svh w-full max-w-md flex-col md:max-w-2xl lg:max-w-none lg:min-w-0 lg:flex-1">
        {!wide && (
          <header className="sticky top-0 z-20 flex h-header items-center justify-between border-b border-ink-100 bg-white/90 px-4 backdrop-blur dark:border-ink-800 dark:bg-ink-900/80">
            {brand}
            <div className="flex items-center gap-2">
              {modeSwitch}
              <NavLink to="/profile" className="flex h-9 w-9 items-center justify-center rounded-full bg-ink-100 dark:bg-ink-800">
                <User size={18} />
              </NavLink>
            </div>
          </header>
        )}

        <Notifier />
        <DriverFeed />
        <DriverDeliveries />
        <ConnectionBanner />
        <main className={clsx("flex-1 lg:px-6 lg:pt-4 lg:pb-12", docked && cards.length > 0 ? "pb-40" : "pb-20")}>
          <AnimatedOutlet />
        </main>
      </div>

      {!wide && (
        <nav className="fixed bottom-0 left-1/2 z-20 flex w-full max-w-md -translate-x-1/2 md:max-w-2xl border-t border-ink-100 bg-white/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-ink-800 dark:bg-ink-900/95">
          <ModeNav mode={mode} cartCount={cartCount} placement="bar" />
        </nav>
      )}
      {docked && <CustomerDock cards={cards} pathname={pathname} wide={wide} />}
      <Toaster lifted={docked && cards.length > 0} />
    </div>
  );
}

const MODES: readonly Mode[] = ["customer", "driver", "merchant"];

/// The places in the current mode, in the bottom bar or the sidebar.
function ModeNav({ mode, cartCount, placement }: { mode: Mode; cartCount: number; placement: NavPlacement }) {
  const t = useT();
  // Orders offered while the driver looked elsewhere -- none once they're back.
  const onDash = useLocation().pathname === "/driver";
  const newOffers = useDriverFeed((s) => (onDash ? 0 : s.unseen));
  if (mode === "customer") {
    return (
      <>
        <NavItem to="/customer" icon={Home} label={t("nav.browse")} placement={placement} />
        <NavItem to="/customer/cart" icon={ShoppingCart} label={t("nav.cart")} badge={cartCount} placement={placement} />
        <NavItem to="/customer/orders" icon={ClipboardList} label={t("nav.orders")} placement={placement} />
        <NavItem to="/rewards" icon={Gift} label={t("nav.rewards")} placement={placement} />
      </>
    );
  }
  if (mode === "driver") {
    return (
      <>
        <NavItem to="/driver" icon={Car} label={t("nav.dash")} badge={newOffers} placement={placement} />
        <NavItem to="/driver/earnings" icon={DollarSign} label={t("nav.earnings")} placement={placement} />
      </>
    );
  }
  return <MerchantNav placement={placement} />;
}

