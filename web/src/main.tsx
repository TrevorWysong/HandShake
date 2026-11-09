import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import "./index.css";
import App from "./App";
import { HOST } from "./holochain/host";
import { loadLocale } from "./i18n";
import { resumeSession } from "./store/session";
import { teachServiceWorker } from "./lib/network/push";

// The person's language first, so the first screen is already in it.
await loadLocale();
// Then, without waiting on it, the session this device remembers.
void resumeSession();
// What a wake shows while the app is closed, in this person's language.
teachServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Asked for less motion, the system's setting is kept: things appear without moving. */}
    <MotionConfig reducedMotion="user">
      <HashRouter>
        <App />
      </HashRouter>
    </MotionConfig>
  </StrictMode>,
);

// Only for a production build served to a browser against the dev host
// (see holochain/host.ts) -- a runtime serves the UI from the device, and
// under `vite dev` it would stale-cache the dev server's own module graph.
// See sw.ts for what it caches (the static app shell only).
if (import.meta.env.PROD && HOST === "dev" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
