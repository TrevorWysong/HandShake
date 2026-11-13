// A driver's deliveries stores found them at fault for, where customers
// choose a driver (docs/REPUTATION.md, phase 3): a count, opening onto what
// each store said and the driver's reply. Shown, never weighed.
import { bytesToHex } from "../../holochain/decode";
import type { AgentPubKey } from "../../holochain/types";
import { FindingsSheet } from "./FindingsSheet";
import { useT } from "../../i18n";

export function DriverFaults({ driver, count }: { driver: AgentPubKey; count: number }) {
  const t = useT();
  return (
    <FindingsSheet target={{ Driver: driver }} targetKey={`driver:${bytesToHex(driver)}`} title={t("findings.driverTitle")} intro={t("findings.driverViewerIntro")}>
      {(open) => (
        <button type="button" onClick={open} className="text-xs font-semibold text-amber-600 underline-offset-2 hover:underline dark:text-amber-400">
          · {t("order.faulted", { count })}
        </button>
      )}
    </FindingsSheet>
  );
}
