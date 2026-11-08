// Where an order in a list stands, as its badge. Two decisions leave a
// delivery's status as it was: one picked up that nobody said more of is
// settled as delivered once the customer's time to claim has run
// (`settle_stalled_delivery`), and a claim it never came is decided
// (`decide_not_delivered`). Only such orders' decisions are read, to say so.
import { getOrderDecisions } from "../../holochain/zomes/dispatch";
import { bytesToHex } from "../../holochain/decode";
import type { DeliveryStatus } from "../../holochain/types";
import type { OrderRow } from "../../lib/orders/orderEntries";
import { useResource } from "../../lib/hooks/useResource";
import { useClock } from "../../lib/hooks/useClock";
import { useTerms } from "../../store/network";
import { PickupStatusBadge, StatusBadge } from "./OrderStatus";
import { Badge } from "../ui";
import { useT } from "../../i18n";

export function OrderRowBadge({ row }: { row: OrderRow }) {
  return row.kind === "Delivery" ? <DeliveryBadge status={row.order.status} orderRef={row.ref} writtenAt={row.writtenAt} /> : <PickupStatusBadge status={row.order.status} />;
}

function DeliveryBadge({ status, orderRef, writtenAt }: { status: DeliveryStatus; orderRef: Uint8Array; writtenAt: number }) {
  const { order_lapse_secs, report_window_secs } = useTerms();
  const now = useClock();
  const t = useT();
  const settles = status === "PickedUp" && now.getTime() * 1000 >= writtenAt + (order_lapse_secs + report_window_secs) * 1_000_000;
  const { data: decisions } = useResource(settles || status === "Disputed" ? `order-decisions:${bytesToHex(orderRef)}` : null, () => getOrderDecisions(orderRef));
  if (status === "Disputed" && decisions?.not_delivered) return <Badge tone="neutral">{t("status.delivery.notDelivered")}</Badge>;
  return <StatusBadge status={decisions?.delivered ? "Delivered" : status} />;
}
