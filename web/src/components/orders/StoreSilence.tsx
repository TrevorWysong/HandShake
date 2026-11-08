// A delivery its store has gone quiet on: one it owes the next step --
// confirming the driver who's committed, checking them in, handing it
// over, or ending it for a driver who left it cooking -- with nobody moving
// it for the network's lapse. Its customer can close it, with no charge;
// the store pays any driver it had checked in, and it counts against it.
// When that applies is the network's own reckoning (`lapses_at`), so this
// never offers what validation would refuse.
import { PhoneOff } from "lucide-react";
import { getOrderTiming, lapseDeliveryOrder } from "../../holochain/zomes/dispatch";
import type { DeliveryOrder } from "../../holochain/types";
import { bytesToHex } from "../../holochain/decode";
import { currentBeacon, PROOF_MARGIN_MICROS } from "../../lib/network/timeSource";
import { POLL } from "../../lib/network/poll";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";
import { useClock } from "../../lib/hooks/useClock";
import { Button } from "../ui";
import { useT } from "../../i18n";

/// Where a store's silence can leave its customer waiting.
const ON_THE_STORE: DeliveryOrder["status"][] = ["Open", "BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore", "Collecting"];

export function StoreSilence({ orderRef, order, onChanged }: { orderRef: Uint8Array; order: DeliveryOrder; onChanged: () => Promise<void> }) {
  const t = useT();
  const now = useClock(30_000);
  const action = useAction();
  const watching = ON_THE_STORE.includes(order.status);
  const { data: timing = null } = useResource(watching ? `order-timing:${bytesToHex(orderRef)}:${order.status}` : null, () => getOrderTiming(orderRef), { pollMs: POLL.signalled });
  const lapsesAt = timing?.lapses_at ?? null;
  if (!watching || lapsesAt === null || now.getTime() * 1000 < lapsesAt + PROOF_MARGIN_MICROS) return null;

  const close = () => action.run(async () => {
    await lapseDeliveryOrder(orderRef, await currentBeacon());
    await onChanged();
  });

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-ink-200 bg-white p-4 dark:border-ink-700 dark:bg-ink-900">
      <div className="flex items-start gap-3">
        <PhoneOff size={18} className="mt-0.5 shrink-0 text-ink-400" />
        <div>
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("order.storeSilentTitle")}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500 dark:text-ink-400">{t("order.storeSilent")}</p>
        </div>
      </div>
      <Button variant="secondary" loading={action.busy} onClick={close}>
        {t("order.closeLapsed")}
      </Button>
      {action.error && <p className="text-xs text-red-600 dark:text-red-400">{action.error}</p>}
    </div>
  );
}
