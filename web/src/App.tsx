import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./store/session";
import { HOST } from "./holochain/host";
import { Spinner } from "./components/ui";
import { Fingerprint } from "lucide-react";
import { AppShell } from "./components/shell/AppShell";
import { Onboarding } from "./routes/Onboarding";
import { Browse } from "./routes/customer/Browse";
import { MerchantDetail } from "./routes/customer/MerchantDetail";
import { Cart } from "./routes/customer/cart/Cart";
import { Orders } from "./routes/customer/Orders";
import { OrderDetail } from "./routes/customer/order/OrderDetail";
import { PickupOrderDetail } from "./routes/customer/order/PickupOrderDetail";
import { DriverDashboard } from "./routes/driver/Dashboard";
import { Earnings } from "./routes/driver/Earnings";
import { Wallet } from "./routes/Wallet";
import { MerchantOrders } from "./routes/merchant/Orders";
import { MerchantCatalog } from "./routes/merchant/Catalog";
import { MerchantRewards } from "./routes/merchant/Rewards";
import { RewardsDetail, RewardsPage } from "./routes/customer/Rewards";
import { RedeemRewards } from "./routes/customer/RedeemRewards";
import { NewStore } from "./routes/merchant/NewStore";
import { ProfilePage } from "./routes/Profile";
import { Transparency } from "./routes/Transparency";
import { Policies } from "./routes/Policies";
import { AccountPage } from "./routes/account/AccountPage";
import VerifyPage from "./routes/Verify";
import ArbitratePage from "./routes/Arbitrate";
import { useLocale, useT } from "./i18n";
import { MovedAway } from "./components/account/MovedAway";
import { Departure } from "./components/account/Departure";
import { useDeparture } from "./store/departure";
import { useAction } from "./lib/hooks/useAction";



function SessionBootstrap({ children }: { children: React.ReactNode }) {
  const t = useT();
  // Started before the first render (`resumeSession`, main.tsx): the
  // remembered identity, reconnecting.
  const resuming = useSession((s) => s.resuming);
  // A passkey-locked identity waits for a tap: a prompt on page load is
  // one Safari refuses or stalls on.
  const [locked, setLocked] = useState(() => {
    const { status, hasStoredIdentity, needsUnlock } = useSession.getState();
    return status === "disconnected" && hasStoredIdentity() && needsUnlock();
  });

  if (locked) return <UnlockScreen onDone={() => setLocked(false)} />;
  if (resuming) {
    return (
      <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-3 text-white">
        <img src="favicon.svg" alt="" className="h-16 w-16 rounded-3xl shadow-xl" />
        <Spinner className="h-6 w-6" />
        {/* A device-locked identity's reconnect can legitimately sit here
            up to a minute waiting on a Touch ID/Windows Hello prompt (an
            OS-level UI this page can't show anything about directly) --
            an unlabeled spinner for that long reads as a frozen page. */}
        <p className="text-xs text-white/70">{t("app.reconnecting")}</p>
      </div>
    );
  }
  return <>{children}</>;
}

/// A remembered identity behind a passkey: unlocked by a tap, which is when
/// the browser shows Touch ID or Windows Hello. "Another way" goes to
/// sign-in, which can still continue as this identity.
function UnlockScreen({ onDone }: { onDone: () => void }) {
  const t = useT();
  const reconnect = useSession((s) => s.reconnect);
  // Unlocked, the app moves on: it stays busy until it does.
  const unlocking = useAction();
  const unlock = () => unlocking.run(async () => {
    try {
      await reconnect();
    } catch (err) {
      // Gone for good (a dev reset): nothing to unlock -- on to sign-in.
      if (err instanceof Error && err.name === "IdentityGone") onDone();
      throw err;
    }
    onDone();
  }, { stayBusy: true });

  return (
    <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-white">
      <img src="favicon.svg" alt="" className="h-16 w-16 rounded-3xl shadow-xl" />
      <p className="text-lg font-bold">{t("app.welcomeBack")}</p>
      <button onClick={unlock} disabled={unlocking.busy} className="flex items-center gap-2 rounded-full bg-white px-6 py-3 font-semibold text-handshake-600 shadow-lg disabled:opacity-60">
        {unlocking.busy ? <Spinner className="h-4 w-4" /> : <Fingerprint size={18} />} {t("app.unlock")}
      </button>
      {unlocking.error && <p className="max-w-xs text-center text-xs text-white/80">{unlocking.error}</p>}
      <button onClick={onDone} className="text-xs text-white/70 underline underline-offset-2">
        {t("app.anotherWay")}
      </button>
    </div>
  );
}

function RequireSession({ children }: { children: React.ReactNode }) {
  const status = useSession((s) => s.status);
  const profile = useSession((s) => s.profile);
  const movedTo = useSession((s) => s.movedTo);
  const movedToNewVersion = useSession((s) => s.movedToNewVersion);
  if (status === "connected" && movedToNewVersion) return <MovedAway to={null} />;
  if (status === "connected" && movedTo) return <MovedAway to={movedTo} />;
  if (status !== "connected" || !profile) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

/// Onboarding is for someone not signed in yet: a signed-in person who
/// arrives at it -- an account just moved from another phone reloads where
/// its move began -- goes home instead. Decided on arrival, so finishing
/// onboarding, which signs the person in partway, isn't cut short.
function RequireSignedOut({ children }: { children: React.ReactNode }) {
  const [signedIn] = useState(() => {
    const { status, profile } = useSession.getState();
    return status === "connected" && !!profile;
  });
  if (signedIn) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function HomeForMode() {
  const mode = useSession((s) => s.mode);
  return <Navigate to={mode === "driver" ? "/driver" : mode === "merchant" ? "/merchant" : "/customer"} replace />;
}

/// A production build opened in a plain browser: there's no conductor here
/// to talk to -- HandShake runs inside its own app (see holochain/host.ts).
function NoHost() {
  const t = useT();
  return (
    <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-4 px-8 text-center text-white">
      <img src="favicon.svg" alt="" className="h-16 w-16 rounded-3xl shadow-xl" />
      <h1 className="text-xl font-black">{t("app.openInApp")}</h1>
      <p className="max-w-sm text-sm text-white/80">
        {t("app.openInAppDetail")}
      </p>
    </div>
  );
}

export default function App() {
  // A change of language remounts the screens, so every word -- including
  // those a screen computed once -- is read again in the new one.
  const locale = useLocale((s) => s.locale);
  // Sent to a new phone: this device has stopped, and connects to nothing.
  const departing = useDeparture((s) => s.sealed);
  if (HOST === "none") return <NoHost />;
  if (departing) return <Departure sealed={departing} />;
  return (
    <SessionBootstrap>
      <Routes key={locale}>
        <Route
          path="/onboarding"
          element={
            <RequireSignedOut>
              <Onboarding />
            </RequireSignedOut>
          }
        />
        <Route
          element={
            <RequireSession>
              <AppShell />
            </RequireSession>
          }
        >
          <Route path="/" element={<HomeForMode />} />
          <Route path="/customer" element={<Browse />} />
          <Route path="/customer/merchant/:hash" element={<MerchantDetail />} />
          <Route path="/customer/cart" element={<Cart />} />
          <Route path="/customer/orders" element={<Orders />} />
          <Route path="/customer/orders/:hash" element={<OrderDetail />} />
          <Route path="/customer/pickup-orders/:hash" element={<PickupOrderDetail />} />
          <Route path="/driver" element={<DriverDashboard />} />
          <Route path="/driver/earnings" element={<Earnings />} />
          <Route path="/merchant" element={<MerchantOrders />} />
          <Route path="/merchant/catalog" element={<MerchantCatalog />} />
          <Route path="/merchant/rewards" element={<MerchantRewards />} />
          <Route path="/rewards" element={<RewardsPage />} />
          <Route path="/rewards/:hash" element={<RewardsDetail />} />
          <Route path="/rewards/:hash/redeem" element={<RedeemRewards />} />
          <Route path="/merchant/stores/new" element={<NewStore />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/transparency" element={<Transparency />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/arbitrate" element={<ArbitratePage />} />
          <Route path="*" element={<HomeForMode />} />
        </Route>
      </Routes>
    </SessionBootstrap>
  );
}
