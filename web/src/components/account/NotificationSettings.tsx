import { useState } from "react";
import { Bell } from "lucide-react";
import { Card, SectionLabel, Switch } from "../ui";
import { unlockChime } from "../../lib/ui/chime";
import { usePreferences } from "../../store/preferences";
import { canWakeWhileClosed, startWakingWhileClosed, stopWakingWhileClosed, wakesWhileClosed } from "../../lib/network/push";
import { useT } from "../../i18n";
import { useAction } from "../../lib/hooks/useAction";

const supported = typeof Notification !== "undefined";

/// This device's notification settings: order updates as system
/// notifications, being woken for them while the app is closed (when the
/// network runs a push relay), and -- on a device running a store -- a
/// chime for each new order.
export function NotificationSettings({ runsStore }: { runsStore: boolean }) {
  const t = useT();
  const { notifications, newOrderChime, setNotifications, setNewOrderChime } = usePreferences();
  const [permission, setPermission] = useState(() => (supported ? Notification.permission : "denied"));

  const [wakes, setWakes] = useState(wakesWhileClosed);
  const switching = useAction();

  // Whatever happened, the switch shows how it's set now.
  const toggleWakes = (on: boolean) => switching.run(async () => {
    try {
      if (on) await startWakingWhileClosed();
      else await stopWakingWhileClosed();
    } finally {
      setWakes(wakesWhileClosed());
    }
  });

  async function toggleNotifications(on: boolean) {
    if (!on) return setNotifications(false);
    const granted = permission === "granted" ? "granted" : await Notification.requestPermission();
    setPermission(granted);
    setNotifications(granted === "granted");
  }

  return (
    <Card className="mb-4 flex flex-col gap-3 p-4">
      <SectionLabel icon={<Bell size={12} />}>{t("notifications.title")}</SectionLabel>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("notifications.orders")}</p>
          <p className="text-xs text-ink-400">
            {!supported ? t("notifications.unsupported") : permission === "denied" ? t("notifications.blocked") : t("notifications.ordersDetail")}
          </p>
        </div>
        <Switch checked={notifications && permission === "granted"} onChange={toggleNotifications} disabled={!supported || permission === "denied"} label={t("notifications.ordersLabel")} />
      </div>
      {canWakeWhileClosed() && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("notifications.closed")}</p>
            <p className={switching.error ? "text-xs text-red-600 dark:text-red-400" : "text-xs text-ink-400"}>{switching.error ?? t("notifications.closedDetail")}</p>
          </div>
          <Switch checked={wakes} onChange={toggleWakes} disabled={switching.busy} label={t("notifications.closedLabel")} />
        </div>
      )}
      {runsStore && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("notifications.chime")}</p>
            <p className="text-xs text-ink-400">{t("notifications.chimeDetail")}</p>
          </div>
          <Switch
            checked={newOrderChime}
            onChange={(on) => {
              // Turning it on is the tap that lets the page play sound.
              if (on) unlockChime();
              setNewOrderChime(on);
            }}
            label={t("notifications.chime")}
          />
        </div>
      )}
    </Card>
  );
}
