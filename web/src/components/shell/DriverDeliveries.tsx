// A driver's deliveries, kept for the whole app: re-read on each change to
// them (and every so often, in case a signal went missing), and -- for each
// one on its way -- their position shared with its customer, on whichever
// screen they're on, online for new orders or not.
import { bytesToHex } from "../../holochain/decode";
import { TRACKED_STATUSES } from "../../lib/driving/deliveryRows";
import { useLocationSharing } from "../../lib/hooks/useLocationSharing";
import { usePolling } from "../../lib/hooks/useResource";
import { POLL, isOrderSignal } from "../../lib/network/poll";
import { refreshCarrying, useCarrying } from "../../store/carrying";
import { useSession } from "../../store/session";

export function DriverDeliveries() {
  const me = useSession((s) => s.agentPubKey);
  const drives = useSession((s) => !!s.profile?.roles.includes("Provider"));
  const driverHex = me && drives ? bytesToHex(me) : null;
  usePolling(() => driverHex && refreshCarrying(driverHex).catch(() => undefined), { pollMs: POLL.signalled, refreshOn: (s) => "BidAccepted" in s || "BidReleased" in s || isOrderSignal(s) }, !!driverHex, driverHex);
  const rows = useCarrying((s) => (driverHex && s.driver === driverHex ? s.rows : undefined));
  const onTheWay = (rows ?? []).filter((row) => TRACKED_STATUSES.includes(row.order.status)).map((row) => bytesToHex(row.hash));
  return onTheWay.map((orderHex) => <SharesLocation key={orderHex} orderHex={orderHex} />);
}

function SharesLocation({ orderHex }: { orderHex: string }) {
  useLocationSharing(orderHex);
  return null;
}
