import { useEffect } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import clsx from "clsx";
import { Home, ClipboardList, ShoppingCart, User, Car, DollarSign, Sparkles, Gift } from "lucide-react";
import { useSession, type Mode } from "../../store/session";
import { useCart } from "../../store/cart";
import { pageVariants } from "../../lib/ui/motion";
import { PresenceDot } from "../ui";
import { NavItem, type NavPlacement } from "./NavItem";
import { MerchantNav } from "./MerchantNav";
import { Notifier } from "./Notifier";
import { Toaster } from "./Toaster";
import { ConnectionBanner } from "./ConnectionBanner";
import { usePolling, useResource } from "../../lib/hooks/useResource";
import { nextNetwork } from "../../lib/account/migration";
import { POLL } from "../../lib/network/poll";
import { collectIncoming } from "../../lib/money/wallet";
import { topUpIfLow } from "../../lib/money/autoTopUp";
import { reaffirmRecoveryPlan } from "../../holochain/zomes/account";
import { bytesToHex } from "../../holochain/decode";
import { useCustomerSettings } from "../../store/roleSettings";
import { useWideScreen } from "../../lib/hooks/useMediaQuery";
import { useT } from "../../i18n";


/// Wraps whichever route is active in a short fade+rise, so navigating
/// between screens (Browse -> cart, an order's detail page, switching
/// modes) feels like one continuous app rather than a hard page swap. Only
/// the arriving screen animates: the one leaving goes at once, so no screen
/// can be left behind mid-exit -- invisible -- however it was left. Each
/// screen starts at its top, as a page does.
function AnimatedOutlet() {
  const location = useLocation();
  return (
    <motion.div key={location.pathname} variants={pageVariants} initial="initial" animate="animate" onAnimationStart={() => window.scrollTo(0, 0)}>
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
  // Funds an issuer added, and cash-outs it declined, land in the balance
  // without anyone having to open the wallet.
  usePolling(() => collectIncoming().catch(() => 0), { pollMs: POLL.unsignalled * 4 }, !!agentPubKey);
  // And a balance that's run low is paid back up, for those who asked.
  const autoTopUp = useCustomerSettings((s) => (agentPubKey ? !!s.autoTopUps[bytesToHex(agentPubKey)] : false));
  usePolling(() => topUpIfLow(agentPubKey!).catch(() => false), { pollMs: POLL.slow }, autoTopUp);
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
  // pages every mode shares (profile, wallet) keep the mode last used.
  const routeMode = MODES.find((m) => pathname === `/${m}` || pathname.startsWith(`/${m}/`));
  const mode = routeMode && availableModes.includes(routeMode) ? routeMode : chosenMode;
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
            "flex-1 rounded-full px-2.5 py-1 capitalize transition",
            mode === m ? "bg-white text-ink-900 shadow-sm dark:bg-ink-950 dark:text-white" : "text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
          )}
        >
          {t(`mode.${m}`)}
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
        <ConnectionBanner />
        <NewVersionBanner enabled={!!agentPubKey} />
        <main className="flex-1 pb-20 lg:px-6 lg:pt-4 lg:pb-12">
          <AnimatedOutlet />
        </main>
      </div>

      {!wide && (
        <nav className="fixed bottom-0 left-1/2 z-20 flex w-full max-w-md -translate-x-1/2 md:max-w-2xl border-t border-ink-100 bg-white/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-ink-800 dark:bg-ink-900/95">
          <ModeNav mode={mode} cartCount={cartCount} placement="bar" />
        </nav>
      )}
      <Toaster />
    </div>
  );
}

const MODES: readonly Mode[] = ["customer", "driver", "merchant"];

/// The places in the current mode, in the bottom bar or the sidebar.
function ModeNav({ mode, cartCount, placement }: { mode: Mode; cartCount: number; placement: NavPlacement }) {
  const t = useT();
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
        <NavItem to="/driver" icon={Car} label={t("nav.dash")} placement={placement} />
        <NavItem to="/driver/earnings" icon={DollarSign} label={t("nav.earnings")} placement={placement} />
      </>
    );
  }
  return <MerchantNav placement={placement} />;
}

/// A line under the header once a new version of HandShake is out
/// (docs/MIGRATION.md): moving there is the person's to start, from Account &
/// recovery.
function NewVersionBanner({ enabled }: { enabled: boolean }) {
  const { data: next } = useResource(enabled ? "next-network" : null, nextNetwork, { pollMs: POLL.slow });
  const t = useT();
  if (!next) return null;
  return (
    <NavLink to="/account" className="flex items-center justify-center gap-2 bg-handshake-500 px-4 py-2 text-xs font-semibold text-white">
      <Sparkles size={13} /> {t("shell.newVersion")}
    </NavLink>
  );
}
