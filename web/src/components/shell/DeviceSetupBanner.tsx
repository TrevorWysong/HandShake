// This device's setup, when part of it couldn't be done (`store/deviceSetup`):
// said so, with a way to try again -- never silently missing, so a device
// that isn't reachable by signals or handoff codes, or isn't doing its
// background work, shows it.
import { Wrench } from "lucide-react";
import { useDeviceSetup } from "../../store/deviceSetup";
import { useT } from "../../i18n";

export function DeviceSetupBanner() {
  const t = useT();
  const { incomplete, running, setUp } = useDeviceSetup();
  if (incomplete.length === 0) return null;
  return (
    <div role="status" className="flex items-center gap-2 bg-amber-100 px-4 py-2 text-xs font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
      <Wrench size={14} />
      <span className="flex-1">{t("deviceSetup.incomplete")}</span>
      <button onClick={() => void setUp()} disabled={running} className="rounded-full bg-white/40 px-3 py-1 disabled:opacity-60">
        {running ? t("connection.retrying") : t("connection.retry")}
      </button>
    </div>
  );
}
