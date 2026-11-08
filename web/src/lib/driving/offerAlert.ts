// Ringing for new orders near a driver, as a driver app pings on each new
// offer: the chime, and -- with the app behind and notifications allowed --
// a notification that opens their dashboard. Which orders are new is the
// feed's to say (`store/driverFeed`).
import { playChime } from "../ui/chime";
import { usePreferences } from "../../store/preferences";
import { t } from "../../i18n";

export function ringForOffers(count: number, open: () => void): void {
  if (count === 0) return;
  const { notifications, newOrderChime } = usePreferences.getState();
  if (newOrderChime) playChime();
  if (notifications && typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState === "hidden") {
    const shown = new Notification(t("drive.newOffers.title"), { body: t("drive.newOffers.body", { count }), tag: "driver-offers" });
    shown.onclick = () => {
      window.focus();
      open();
      shown.close();
    };
  }
}
