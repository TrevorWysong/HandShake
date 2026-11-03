import { useResource } from "../../../lib/hooks/useResource";
import { useParams } from "react-router-dom";
import { ChefHat } from "lucide-react";
import { motion } from "framer-motion";
import { cancelPickupOrder, getOrderPrivateDetails, getPickupOrder, reportPickupProblem, completePickup } from "../../../holochain/zomes/dispatch";
import { fetchOrderItemNames } from "../../../lib/storefront/menu";
import { decodeEntry, bytesEqual, bytesToHex, hexToBytes, timestampOf } from "../../../holochain/decode";
import { getCatalog } from "../../../holochain/zomes/catalog";
import { myAgentPubKey } from "../../../holochain/client";
import { PickupStatusTimeline, PickupStatusBadge } from "../../../components/orders/OrderStatus";
import { Button, Card, Notice, Skeleton, StatNumber } from "../../../components/ui";
import { WaitingForStore } from "../../../components/orders/WaitingForStore";
import { formatCents, formatClockTime } from "../../../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../../../lib/ui/motion";
import { useAction } from "../../../lib/hooks/useAction";
import type { MerchantCatalog, PickupOrder } from "../../../holochain/types";
import { POLL, isOrderSignal } from "../../../lib/network/poll";
import { OrderReceipt } from "../../../components/orders/OrderReceipt";
import { OrderPointsBadge } from "../../../components/rewards/PendingPoints";
import { OrderSummary } from "../../../components/orders/OrderLines";
import { OrderIssues } from "../../../components/orders/OrderIssues";
import { ChatPanel } from "../../../components/orders/ChatPanel";
import { RateOrder } from "../../../components/orders/RateOrder";
import { useT } from "../../../i18n";


/// `OrderDetail`'s pickup sibling -- no bids, no driver, no live map, no
/// chat: the requester and the merchant are the only two parties, and
/// there's nothing to track en route since there's no en route. See
/// `PickupOrder`'s own doc comment (`dispatch_integrity`) for why this is a
/// wholly separate entry type and screen rather than a conditional branch
/// inside `OrderDetail`.
export function PickupOrderDetail() {
  const { hash = "" } = useParams<{ hash: string }>();
  const orderRef = hexToBytes(hash);
  const t = useT();
  // One step on the order at a time: no cancelling it while confirming it.
  const action = useAction();

  // `writtenAt` (when its current version was written) and `now` (when it
  // was read) time the store's window to accept it.
  const { data: snapshot, reload: reloadOrder } = useResource(
    `pickup-order:${hash}`,
    async () => {
      const record = await getPickupOrder(orderRef);
      return { order: decodeEntry<PickupOrder>(record), writtenAt: timestampOf(record), now: Date.now() };
    },
    { pollMs: POLL.signalled, refreshOn: (signal) => "PickupReady" in signal || isOrderSignal(signal) },
  );
  const order = snapshot?.order;
  // The kitchen note is sealed to the store; the zome opens it for us.
  const { data: details } = useResource(`pickup-order-details:${hash}`, () => getOrderPrivateDetails(orderRef));
  const { data: itemNames = {} } = useResource(order ? `pickup-order-items:${hash}` : null, () => fetchOrderItemNames(order!));
  const storeHex = order ? bytesToHex(order.catalog_ref) : null;
  const { data: storeName } = useResource(storeHex && `store-name:${storeHex}`, async () => decodeEntry<MerchantCatalog>(await getCatalog(order!.catalog_ref)).business_name);

  if (!order) {
    return (
      <div className="flex flex-col gap-3 px-4 pt-4">
        <Skeleton className="h-7 w-2/5" />
        <Card className="p-4">
          <Skeleton className="h-4 w-full mb-3" />
          <Skeleton className="h-4 w-3/4 mb-3" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
      </div>
    );
  }

  const fileDispute = () => action.run(async () => {
    await reportPickupProblem(orderRef);
    await reloadOrder();
  }, { as: "dispute" });

  const confirmPickup = () => action.run(async () => {
    await completePickup(orderRef);
    await reloadOrder();
  }, { as: "complete" });

  const cancel = () => action.run(async () => {
    await cancelPickupOrder(orderRef);
    await reloadOrder();
  }, { as: "cancel" });

  // A merchant collecting from their own store has nothing to rate --
  // validate_review/validate_item_review reject self-ratings anyway.
  const selfOrder = bytesEqual(order.merchant, myAgentPubKey());

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center justify-between">
        <div className="min-w-0">
          <h1 className="flex items-baseline gap-1.5 text-xl font-black text-ink-900 dark:text-ink-50">
            {t("pickup.heading")}<StatNumber className="text-xl">{formatCents(order.order_total)}</StatNumber>
          </h1>
          {storeName && <p className="truncate text-xs text-ink-400">{t("cart.from", { store: storeName })}</p>}
        </div>
        <PickupStatusBadge status={order.status} />
      </motion.div>

      {order.status !== "PickedUp" && (
        <motion.div variants={fadeSlideUp} className="-mt-2 mb-4">
          <OrderSummary orderRef={orderRef} count={order.lines.reduce((n, l) => n + l.quantity, 0)} />
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp}>
        <Card className="p-4">
          <PickupStatusTimeline status={order.status} cancellation={order.cancellation} />
        </Card>
      </motion.div>

      {!selfOrder && order.status !== "PickedUp" && order.status !== "Cancelled" && (
        <motion.div variants={fadeSlideUp}>
          <ChatPanel orderRef={orderRef} title={t("pickup.chat")} counterpart={t("chat.store")} />
        </motion.div>
      )}

      {details?.kitchen_note && (
        <motion.div variants={fadeSlideUp}>
          <Card className="mt-3 flex flex-col gap-1 p-4 text-sm">
            <p className="text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.storeNoteLabel")} </span>
              {details.kitchen_note}
            </p>
          </Card>
        </motion.div>
      )}

      {order.status === "Placed" && snapshot && (
        <motion.div variants={fadeSlideUp}>
          <WaitingForStore writtenAt={snapshot.writtenAt} now={snapshot.now} cancelling={action.doing === "cancel"} onCancel={cancel} />
        </motion.div>
      )}

      {order.status === "MerchantConfirmed" && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex items-center gap-3 rounded-2xl bg-handshake-50 dark:bg-handshake-900/20 p-4">
          <ChefHat size={20} className="text-handshake-600" />
          <p className="text-sm text-handshake-700 dark:text-handshake-300">
            {order.ready_by !== null ? t("pickup.preparingBy", { time: formatClockTime(order.ready_by) }) : t("pickup.preparing")}
          </p>
        </motion.div>
      )}

      {(order.status === "ReadyForPickup" || order.status === "Disputed") && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex flex-col gap-3 rounded-2xl bg-handshake-50 dark:bg-handshake-900/20 p-4">
          <div className="flex items-center gap-3">
            <ChefHat size={20} className="text-handshake-600" />
            <p className="text-sm text-handshake-700 dark:text-handshake-300">
              {order.status === "Disputed" ? t("pickup.disputed") : t("pickup.ready")}
            </p>
          </div>
          <Button loading={action.doing === "complete"} disabled={action.busy} onClick={confirmPickup}>
            {t("pickup.pickedUp")}
          </Button>
          {order.status === "ReadyForPickup" && (
            <button onClick={fileDispute} disabled={action.busy} className="text-xs font-semibold text-handshake-700 underline-offset-4 hover:underline disabled:opacity-50 dark:text-handshake-300">
              {t("pickup.cantGet")}
            </button>
          )}
        </motion.div>
      )}

      <OrderPointsBadge orderRef={orderRef} />

      {order.status === "PickedUp" && (
        <motion.div variants={fadeSlideUp}>
          <OrderIssues orderRef={orderRef} role="customer" />
          <OrderReceipt orderRef={orderRef} />
        </motion.div>
      )}


      {order.status === "PickedUp" && <RateOrder orderRef={orderRef} order={order} itemNames={itemNames} selfOrder={selfOrder} />}

      {action.error && <Notice className="mt-4">{action.error}</Notice>}
    </motion.div>
  );
}
