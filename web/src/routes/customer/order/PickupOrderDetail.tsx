import { useState } from "react";
import { useResource } from "../../../lib/hooks/useResource";
import { useParams } from "react-router-dom";
import { AlertTriangle, ChefHat } from "lucide-react";
import { motion } from "framer-motion";
import { cancelPickupOrder, getOrderDecisions, lapsePickupOrder, getOrderPrivateDetails, getPickupOrder, reportPickupProblem, completePickup } from "../../../holochain/zomes/dispatch";
import { fetchOrderItemNames } from "../../../lib/storefront/menu";
import { decodeEntry, bytesEqual, bytesToHex, hexToBytes, timestampOf } from "../../../holochain/decode";
import { getCatalog } from "../../../holochain/zomes/catalog";
import { myAgentPubKey } from "../../../holochain/client";
import { PickupStatusTimeline } from "../../../components/orders/OrderStatus";
import { AllergyRequest } from "../../../components/store/Allergens";
import { OrderHero } from "../../../components/orders/OrderHero";
import { customerProgress, orderEstimate } from "../../../lib/orders/progress";
import { useClock } from "../../../lib/hooks/useClock";
import { Button, Card, Notice, Skeleton, StatNumber } from "../../../components/ui";
import { WaitingForStore } from "../../../components/orders/WaitingForStore";
import { formatCents, formatClockTime, formatDeadline } from "../../../lib/ui/format";
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
import { useTerms } from "../../../store/network";
import { Sheet } from "../../../components/Sheet";
import { StoreReach } from "../../../components/store/StoreContact";
import { currentBeacon, PROOF_MARGIN_MICROS } from "../../../lib/network/timeSource";
import { OrderPayments } from "../../../components/payments/OrderPayments";


/// `OrderDetail`'s pickup sibling -- no bids, no driver, no live map, no
/// chat: the requester and the merchant are the only two parties, and
/// there's nothing to track en route since there's no en route. See
/// `PickupOrder`'s own doc comment (`dispatch_integrity`) for why this is a
/// wholly separate entry type and screen rather than a conditional branch
/// inside `OrderDetail`.
export function PickupOrderDetail() {
  const { hash = "" } = useParams<{ hash: string }>();
  const now = useClock();
  const orderRef = hexToBytes(hash);
  const t = useT();
  // One step on the order at a time: no cancelling it while confirming it.
  const action = useAction();
  const { collection_window_secs: collectionWindowSecs, answer_grace_secs: answerGraceSecs, order_lapse_secs: lapseSecs } = useTerms();
  const [askingCantGet, setAskingCantGet] = useState(false);

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
  const { data: store } = useResource(storeHex && `store-catalog:${storeHex}`, async () => decodeEntry<MerchantCatalog>(await getCatalog(order!.catalog_ref)));
  // Ready again on the store's answer to a report: there's no reporting it twice.
  const { data: decisions } = useResource(order?.status === "ReadyForPickup" ? `pickup-decisions:${hash}:${snapshot?.writtenAt}` : null, () => getOrderDecisions(orderRef));

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
    setAskingCantGet(false);
  }, { as: "dispute" });

  const confirmPickup = () => action.run(async () => {
    await completePickup(orderRef);
    await reloadOrder();
  }, { as: "complete" });

  const closeLapsed = () => action.run(async () => {
    await lapsePickupOrder(orderRef, await currentBeacon());
    await reloadOrder();
  }, { as: "lapse" });

  const cancel = () => action.run(async () => {
    await cancelPickupOrder(orderRef);
    await reloadOrder();
  }, { as: "cancel" });

  // A merchant collecting from their own store has nothing to rate --
  // validate_review/validate_item_review reject self-ratings anyway.
  const selfOrder = bytesEqual(order.merchant, myAgentPubKey());
  // Their window to collect it: from when it was ready, or the store said so again.
  const collectBy = (snapshot?.writtenAt ?? 0) + collectionWindowSecs * 1_000_000;
  // A store gone silent on it since its last word: the customer can close it.
  const waitingOnStore = order.status === "MerchantConfirmed" || order.status === "ReadyForPickup" || order.status === "Disputed";
  // Counted from its last word -- or, while it's being made, from when it's
  // due ready -- as the network counts it.
  const waitsFrom = Math.max(snapshot?.writtenAt ?? 0, order.status === "MerchantConfirmed" ? (order.ready_by ?? 0) : 0);
  const lapsed = waitingOnStore && !!snapshot && now.getTime() * 1000 >= waitsFrom + lapseSecs * 1_000_000 + PROOF_MARGIN_MICROS;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div variants={fadeSlideUp}>
        <OrderHero progress={customerProgress({ kind: "Pickup", order })} eyebrow={store?.business_name} estimate={orderEstimate({ kind: "Pickup", order }, null, now.getTime() * 1000)}>
          <PickupStatusTimeline status={order.status} cancellation={order.cancellation} />
        </OrderHero>
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mt-3 flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("pickup.heading")}<StatNumber className="ml-1.5 text-sm">{formatCents(order.order_total)}</StatNumber></h2>
      </motion.div>
      {order.status !== "PickedUp" && (
        <motion.div variants={fadeSlideUp} className="mt-1 mb-1">
          <OrderSummary orderRef={orderRef} count={order.lines.reduce((n, l) => n + l.quantity, 0)} />
        </motion.div>
      )}

      {/* Their card, held by the store: confirming, or what it needs. */}
      {order.status !== "Cancelled" && (
        <motion.div variants={fadeSlideUp} className="mt-3">
          <OrderPayments order={orderRef} delivery={false} compact={order.status !== "Placed"} />
        </motion.div>
      )}

      {!selfOrder && order.status !== "PickedUp" && order.status !== "Cancelled" && (
        <motion.div variants={fadeSlideUp}>
          <ChatPanel orderRef={orderRef} title={t("pickup.chat")} counterpart={t("chat.store")} />
        </motion.div>
      )}

      {details && <motion.div variants={fadeSlideUp}><AllergyRequest allergies={details.allergies} heading={t("order.youTold")} /></motion.div>}
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

      {order.status === "ReadyForPickup" && snapshot && (
        decisions?.report_dismissed ? (
          <motion.div variants={fadeSlideUp} className="mt-5 flex flex-col gap-3 rounded-2xl bg-amber-50 p-4 dark:bg-amber-900/20">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" />
              <p className="text-sm text-amber-900 dark:text-amber-100">
                {collectBy > now.getTime() * 1000 ? t("pickup.dismissed", { time: formatDeadline(collectBy) }) : t("pickup.dismissedLate")}
              </p>
            </div>
            {store && <StoreReach catalog={store} />}
            <Button loading={action.doing === "complete"} disabled={action.busy} onClick={confirmPickup}>
              {t("pickup.pickedUp")}
            </Button>
          </motion.div>
        ) : (
          <motion.div variants={fadeSlideUp} className="mt-5 flex flex-col gap-3 rounded-2xl bg-handshake-50 dark:bg-handshake-900/20 p-4">
            <div className="flex items-center gap-3">
              <ChefHat size={20} className="shrink-0 text-handshake-600" />
              <p className="text-sm text-handshake-700 dark:text-handshake-300">
                {collectBy > now.getTime() * 1000 ? t("pickup.ready", { time: formatDeadline(collectBy) }) : t("pickup.readyLate")}
              </p>
            </div>
            <Button loading={action.doing === "complete"} disabled={action.busy} onClick={confirmPickup}>
              {t("pickup.pickedUp")}
            </Button>
            {decisions && (
              <button onClick={() => setAskingCantGet(true)} disabled={action.busy} className="text-xs font-semibold text-handshake-700 underline-offset-4 hover:underline disabled:opacity-50 dark:text-handshake-300">
                {t("pickup.cantGet")}
              </button>
            )}
          </motion.div>
        )
      )}

      {order.status === "Disputed" && snapshot && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex flex-col gap-3 rounded-2xl bg-amber-50 p-4 dark:bg-amber-900/20">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" />
            <p className="text-sm text-amber-900 dark:text-amber-100">{t("pickup.disputed", { time: formatDeadline(snapshot.writtenAt + answerGraceSecs * 1_000_000) })}</p>
          </div>
          {store && <StoreReach catalog={store} />}
          <Button variant="secondary" loading={action.doing === "complete"} disabled={action.busy} onClick={confirmPickup}>
            {t("pickup.gotItAfterAll")}
          </Button>
        </motion.div>
      )}

      <Sheet
        open={askingCantGet}
        onClose={() => setAskingCantGet(false)}
        title={t("pickup.cantGet")}
        subtitle={t("pickup.cantGetIntro")}
        footer={
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" disabled={action.busy} onClick={() => setAskingCantGet(false)}>
              {t("common.back")}
            </Button>
            <Button className="flex-1" loading={action.doing === "dispute"} onClick={fileDispute}>
              {t("pickup.tellStore")}
            </Button>
          </div>
        }
      >
        <ul className="flex list-disc flex-col gap-2 pb-3 pl-4 text-sm text-ink-600 dark:text-ink-300">
          <li>{t("pickup.cantGetTold")}</li>
          <li>{t("pickup.cantGetOutcome")}</li>
          <li>{t("pickup.cantGetLate")}</li>
        </ul>
        {store && <StoreReach catalog={store} className="mb-2" />}
      </Sheet>

      {lapsed && (
        <motion.div variants={fadeSlideUp} className="mt-3 flex flex-col gap-3 rounded-2xl border border-ink-200 bg-white p-4 dark:border-ink-700 dark:bg-ink-900">
          <p className="text-sm text-ink-700 dark:text-ink-200">{t("pickup.lapsed")}</p>
          <Button variant="secondary" loading={action.doing === "lapse"} disabled={action.busy} onClick={closeLapsed}>
            {t("order.closeLapsed")}
          </Button>
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
