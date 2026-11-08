// A driver hearing of new orders near them as their feed finds them, as a
// driver app pings on each new offer: the chime, and -- with the app behind
// and notifications allowed -- a notification. The first read after going
// online only takes note of what's already there.
import { playChime } from "../ui/chime";
import { usePreferences } from "../../store/preferences";
import { t } from "../../i18n";

const seen = new Set<string>();
let primed = false;

/// Going online: what's in the feed then is what they see, not news.
export function resetOfferAlerts(): void {
  seen.clear();
  primed = false;
}

/// Rings for whichever of `orderHexes` haven't been offered before.
export function alertNewOffers(orderHexes: string[]): void {
  const fresh = orderHexes.filter((hex) => !seen.has(hex));
  for (const hex of fresh) seen.add(hex);
  if (!primed) {
    primed = true;
    return;
  }
  if (fresh.length === 0) return;
  const { notifications, newOrderChime } = usePreferences.getState();
  if (newOrderChime) playChime();
  if (notifications && typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState === "hidden") {
    const shown = new Notification(t("drive.newOffers.title"), { body: t("drive.newOffers.body", { count: fresh.length }), tag: "driver-offers" });
    shown.onclick = () => {
      window.focus();
      shown.close();
    };
  }
}
