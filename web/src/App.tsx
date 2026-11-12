import { Fragment, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./store/session";
import { bytesToHex } from "./holochain/decode";
import { HOST } from "./holochain/host";
import { Spinner } from "./components/ui";
import { Fingerprint } from "lucide-react";
import { AppShell } from "./components/shell/AppShell";
import { Screen } from "./components/shell/Screen";
import { Onboarding } from "./routes/Onboarding";
import { Browse } from "./routes/customer/Browse";
import { MerchantDetail } from "./routes/customer/MerchantDetail";
import { StoreInfo } from "./routes/customer/StoreInfo";
import { TermsAcceptance, TermsOfUse } from "./routes/Terms";
import { TERMS_VERSION } from "./lib/policies/termsVersion";
import { useTermsAcceptance } from "./store/termsAcceptance";
import { Cart } from "./routes/customer/cart/Cart";
import { Carts } from "./routes/customer/cart/Carts";
import { Orders } from "./routes/customer/Orders";
import { OrderDetail } from "./routes/customer/order/OrderDetail";
import { PickupOrderDetail } from "./routes/customer/order/PickupOrderDetail";
import { DriverDashboard } from "./routes/driver/Dashboard";
import { Earnings } from "./routes/driver/Earnings";
import { Payments } from "./routes/Payments";
import { MerchantOrders } from "./routes/merchant/Orders";
import { MerchantMenu } from "./routes/merchant/Menu";
import { MerchantStore } from "./routes/merchant/Store";
import { MerchantPromos } from "./routes/merchant/Promos";
import { MerchantRewards } from "./routes/merchant/Rewards";
import { RewardsDetail, RewardsPage } from "./routes/customer/Rewards";
import { RedeemRewards } from "./routes/customer/RedeemRewards";
import { NewStore } from "./routes/merchant/NewStore";
import { ProfilePage } from "./routes/Profile";
import { Policies } from "./routes/Policies";
import { AccountPage } from "./routes/account/AccountPage";
import VerifyPage from "./routes/Verify";
import ArbitratePage from "./routes/Arbitrate";
import { useLocale, useT } from "./i18n";
import { MovedAway } from "./components/account/MovedAway";
import { Departure } from "./components/account/Departure";
import { useDeparture } from "./store/departure";
import { Arrival } from "./components/account/Arrival";
import { useArrival } from "./store/arrival";
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
  const identity = useSession((s) => (s.agentPubKey ? bytesToHex(s.agentPubKey) : null));
  if (status === "connected" && movedToNewVersion) return <MovedAway to={null} />;
  if (status === "connected" && movedTo) return <MovedAway to={movedTo} />;
  if (status !== "connected" || !profile) return <Navigate to="/onboarding" replace />;
  // Another identity signed in remounts every screen: nothing one read for
  // the last person stays on it. (Onboarding, which signs a person in
  // partway, carries on.)
  return <Fragment key={identity}>{children}</Fragment>;
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
  // Just received from another phone: nothing's written until it checks
  // the old phone didn't take the account back.
  const arriving = useArrival((s) => s.head);
  const termsAccepted = useTermsAcceptance((s) => s.acceptedVersion === TERMS_VERSION);
  if (HOST === "none") return <NoHost />;
  if (departing) return <Departure sealed={departing} />;
  // Nothing connects, and nothing's shown, until these are agreed.
  if (!termsAccepted) return <TermsAcceptance key={locale} />;
  return (
    <SessionBootstrap>
      {arriving ? <Arrival head={arriving} /> : <Routes key={locale}>
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
          <Route path="/customer" element={<Screen width="wide"><Browse /></Screen>} />
          <Route path="/customer/merchant/:hash" element={<Screen width="wide"><MerchantDetail /></Screen>} />
          <Route path="/customer/merchant/:hash/about" element={<Screen width="reading"><StoreInfo /></Screen>} />
          <Route path="/customer/cart" element={<Screen width="reading"><Carts /></Screen>} />
          <Route path="/customer/cart/:store" element={<Screen width="wide"><Cart /></Screen>} />
          <Route path="/customer/orders" element={<Screen width="reading"><Orders /></Screen>} />
          <Route path="/customer/orders/:hash" element={<Screen width="wide"><OrderDetail /></Screen>} />
          <Route path="/customer/pickup-orders/:hash" element={<Screen width="reading"><PickupOrderDetail /></Screen>} />
          <Route path="/driver" element={<Screen width="wide"><DriverDashboard /></Screen>} />
          <Route path="/driver/earnings" element={<Screen width="medium"><Earnings /></Screen>} />
          <Route path="/merchant" element={<Screen width="wide"><MerchantOrders /></Screen>} />
          <Route path="/merchant/menu" element={<Screen width="medium"><MerchantMenu /></Screen>} />
          <Route path="/merchant/promos" element={<Screen width="medium"><MerchantPromos /></Screen>} />
          <Route path="/merchant/rewards" element={<Screen width="wide"><MerchantRewards /></Screen>} />
          <Route path="/merchant/store" element={<Screen width="medium"><MerchantStore /></Screen>} />
          <Route path="/rewards" element={<Screen width="wide"><RewardsPage /></Screen>} />
          <Route path="/rewards/:hash" element={<Screen width="reading"><RewardsDetail /></Screen>} />
          <Route path="/rewards/:hash/redeem" element={<Screen width="reading"><RedeemRewards /></Screen>} />
          <Route path="/merchant/stores/new" element={<Screen width="reading"><NewStore /></Screen>} />
          <Route path="/profile" element={<Screen width="reading"><ProfilePage /></Screen>} />
          <Route path="/transparency" element={<Navigate to="/payments" replace />} />
          <Route path="/payments" element={<Screen width="reading"><Payments /></Screen>} />
          <Route path="/policies" element={<Screen width="reading"><Policies /></Screen>} />
          <Route path="/terms" element={<Screen width="reading"><TermsOfUse /></Screen>} />
          <Route path="/account" element={<Screen width="reading"><AccountPage /></Screen>} />
          <Route path="/verify" element={<Screen width="reading"><VerifyPage /></Screen>} />
          <Route path="/arbitrate" element={<Screen width="reading"><ArbitratePage /></Screen>} />
          <Route path="*" element={<HomeForMode />} />
        </Route>
      </Routes>}
    </SessionBootstrap>
  );
}
