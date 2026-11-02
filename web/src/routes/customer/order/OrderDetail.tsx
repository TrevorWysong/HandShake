import { useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, Bike, DoorOpen, ShieldCheck, Zap } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cancelOrder, claimNeverArrived, getMyHandoverCode, getOrder, getOrderDecisions, getOrderPrivateDetails, listBidsForOrder, acceptBid, confirmCollected } from "../../../holochain/zomes/dispatch";
import { confirmDeliveryReceived, HandoffNotYetHere } from "../../../lib/orders/handoffs";
import { getCatalog } from "../../../holochain/zomes/catalog";
import { fetchOrderItemNames } from "../../../lib/storefront/menu";
import { getHandoffEvidence, getLegsForOrder } from "../../../holochain/zomes/attestation";
import { decodeEntry, actionHash, bytesEqual, bytesToHex, hexToBytes, timestampOf } from "../../../holochain/decode";
import { myAgentPubKey } from "../../../holochain/client";
import { OrderStatusTimeline, StatusBadge } from "../../../components/orders/OrderStatus";
import { Button, Card, Notice, SectionLabel, Skeleton, StatNumber } from "../../../components/ui";
import { ChatPanel } from "../../../components/orders/ChatPanel";
import { NetworkReach } from "../../../components/orders/NetworkReach";
import { LiveMap } from "../../../components/places/LiveMap";
import { WaitingForStore } from "../../../components/orders/WaitingForStore";
import { formatCatalogAddress, formatCents, formatClockTime, formatDeadline } from "../../../lib/ui/format";
import { received } from "../../../lib/orders/orderEntries";
import { LateOrder } from "../../../components/orders/LateOrder";
import { fadeSlideUp, staggerContainer } from "../../../lib/ui/motion";
import { useAction } from "../../../lib/hooks/useAction";
import { useResource } from "../../../lib/hooks/useResource";
import type { Bid, DeliveryOrder, DeliveryStatus, Leg, MerchantCatalog } from "../../../holochain/types";
import { POLL, isOrderOrBidSignal, isOrderSignal } from "../../../lib/network/poll";
import { OrderReceipt } from "../../../components/orders/OrderReceipt";
import { OrderPointsBadge } from "../../../components/rewards/PendingPoints";
import { RateOrder } from "../../../components/orders/RateOrder";
import { OrderBids } from "./OrderBids";
import { OrderSummary } from "../../../components/orders/OrderLines";
import { OrderIssues } from "../../../components/orders/OrderIssues";
import { useT, type MessageKey } from "../../../i18n";
import { HandoverCode } from "../../../components/orders/HandoverCode";

// Chat is only valid once a driver is assigned (live_counterpart needs
// order.accepted_bid to exist) and before the delivery's own terminal state.
const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = ["BidAccepted", "MerchantConfirmed", "DriverEnRouteToMerchant", "PickedUp"];

const DROPOFF_PREFERENCE_LABEL: Record<DeliveryOrder["dropoff_preference"], MessageKey> = {
  LeaveAtDoor: "cart.drop.leaveAtDoor",
  HandToMe: "cart.drop.handToMe",
  MeetOutside: "cart.drop.meetOutside",
};

/// What the customer's told while a driver has their order.
const DRIVER_PROGRESS: Partial<Record<DeliveryOrder["status"], MessageKey>> = {
  BidAccepted: "order.progress.bidAccepted",
  DriverEnRouteToMerchant: "order.progress.enRoute",
  MerchantConfirmed: "order.progress.confirmed",
  DriverAtStore: "order.progress.atStore",
};

export function OrderDetail() {
  const { hash = "" } = useParams<{ hash: string }>();
  const orderRef = hexToBytes(hash);
  const t = useT();
  const [confirmingClaim, setConfirmingClaim] = useState(false);
  // One step on the order at a time: no cancelling it while confirming it.
  const action = useAction();

  // Each read below is keyed by exactly what it depends on, so it's fetched
  // once per value and re-read only when that changes (or while polled).
  // `writtenAt` (when its current version was written) and `now` (when it
  // was read) time the store's window to accept it.
  const { data: snapshot, reload: reloadOrder } = useResource(
    `order:${hash}`,
    async () => {
      const record = await getOrder(orderRef);
      return { order: decodeEntry<DeliveryOrder>(record), writtenAt: timestampOf(record), now: Date.now() };
    },
    { pollMs: POLL.signalled, refreshOn: isOrderOrBidSignal },
  );
  const order = snapshot?.order;
  const storeHex = order ? bytesToHex(order.catalog_ref) : null;
  // The store: where the order's picked up, and its address for a customer
  // collecting it themselves.
  const { data: store = null } = useResource(storeHex && `order-store:${storeHex}`, async () => {
    const catalog = decodeEntry<MerchantCatalog>(await getCatalog(order!.catalog_ref));
    return { location: catalog.location, address: formatCatalogAddress(catalog), name: catalog.business_name };
  });
  const pickup = store?.location ?? null;
  // The exact drop-off and notes are sealed; the zome opens them for us.
  const { data: details } = useResource(`order-details:${hash}`, () => getOrderPrivateDetails(orderRef));
  const { data: itemNames = {} } = useResource(order ? `order-items:${hash}` : null, () => fetchOrderItemNames(order!));
  // The drop-off photo can only appear once the order's picked up; polled
  // until the handoff leg is attested, then read once more on delivery.
  const photoStatus = order && (order.status === "PickedUp" || order.status === "Delivered") ? order.status : null;
  const { data: dropoff = null } = useResource(
    photoStatus && `order-dropoff:${hash}:${photoStatus}`,
    async () => {
      const record = (await getLegsForOrder(orderRef)).find((r) => decodeEntry<Leg>(r).kind === "CustomerHandoff");
      if (!record) return null;
      // Sealed to this customer; only they and the driver can open it.
      const evidence = await getHandoffEvidence(actionHash(record));
      return { at: timestampOf(record), photo: evidence?.photo_data_uri || null };
    },
    { pollMs: photoStatus === "PickedUp" ? POLL.signalled : undefined, refreshOn: (s) => "HandoffRecorded" in s || isOrderSignal(s) },
  );
  const dropoffPhoto = dropoff?.photo ?? null;
  // Where a claim that it never arrived stands with the store.
  const { data: decisions } = useResource(order?.status === "Disputed" ? `order-decisions:${hash}` : null, () => getOrderDecisions(orderRef), { pollMs: POLL.signalled, refreshOn: isOrderOrBidSignal });
  // The customer's handover code, while a driver's on the way: shown at the
  // door. An order left at the door has no handover.
  const handedOver = order?.dropoff_preference !== "LeaveAtDoor";
  const awaitingDriver = order && handedOver && ["BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore", "PickedUp"].includes(order.status) && !dropoff;
  // Shown to the driver at the door -- or to the store, collecting it.
  const collecting = order?.status === "Collecting";
  const { data: handoverCode = null } = useResource(awaitingDriver || collecting ? `handover-code:${hash}` : null, () => getMyHandoverCode(orderRef));
  // The accepted bid's driver -- found among the order's bids, since bids
  // are only ever read through their order.
  const acceptedHex = order?.accepted_bid ? bytesToHex(order.accepted_bid) : null;
  const { data: driver = null } = useResource(acceptedHex && `order-driver:${acceptedHex}`, async () => {
    const page = await listBidsForOrder(orderRef);
    const won = page.bids.find((record) => bytesToHex(actionHash(record)) === acceptedHex);
    return won ? decodeEntry<Bid>(won).bidder : null;
  });

  if (!order) {
    return (
      <div className="flex flex-col gap-3 px-4 pt-4">
        <Skeleton className="h-7 w-2/5" />
        <Card className="p-4">
          <Skeleton className="h-4 w-full mb-3" />
          <Skeleton className="h-4 w-3/4 mb-3" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
        <Card className="p-4">
          <Skeleton className="h-16 w-full" />
        </Card>
      </div>
    );
  }

  const confirmCollectedHere = () => action.run(async () => {
    await confirmCollected(orderRef);
    await reloadOrder();
  }, { as: "collected" });

  /// Accepts a bid -- `overrideWarrants` once the customer has seen the
  /// driver's complaints and chosen them anyway.
  const pickBid = (bidHash: Uint8Array, overrideWarrants: boolean) => action.run(async () => {
    await acceptBid(orderRef, bidHash, overrideWarrants);
    await reloadOrder();
  }, { as: `bid:${bytesToHex(bidHash)}` });

  const claimItNeverArrived = () => action.run(async () => {
    await claimNeverArrived(orderRef);
    setConfirmingClaim(false);
    await reloadOrder();
  }, { as: "claim" });

  // The driver's drop-off record is written on their chain and gossips
  // here; right after the handoff it may not have arrived yet. Retry a few
  // times before saying so.
  const confirmReceipt = () => action.run(async () => {
    const RETRY_DELAYS_MS = [1500, 3000, 6000, 10000];
    for (let attempt = 0; ; attempt++) {
      try {
        await confirmDeliveryReceived(orderRef);
        break;
      } catch (err) {
        if (!(err instanceof HandoffNotYetHere) || attempt >= RETRY_DELAYS_MS.length) throw err;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    await reloadOrder();
  }, { as: "complete" });

  const cancel = () => action.run(async () => {
    await cancelOrder(orderRef);
    await reloadOrder();
  }, { as: "cancel" });

  // A merchant who ordered from their own store has no store to rate.
  const selfOrder = bytesEqual(order.merchant, myAgentPubKey());

  // A delivery on its way shows where it is, with its chat.
  const live = ACTIVE_DELIVERY_STATUSES.includes(order.status);

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      {/* Where it stands and what to do, with the map and chat beside it on a wide
          screen while it's on its way; one column, in this order, on a phone. */}
      <div className={live ? "lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-x-8" : "lg:mx-auto lg:max-w-2xl"}>
        <div className="min-w-0 lg:col-start-1">
          <motion.div variants={fadeSlideUp} className="mb-4 flex items-center justify-between">
            <h1 className="flex items-baseline gap-1.5 text-xl font-black text-ink-900 dark:text-ink-50">
              {t("order.heading")}<StatNumber className="text-xl">{formatCents(order.order_total)}</StatNumber>
            </h1>
            <div className="flex items-center gap-1.5">
              {order.priority && (
                <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                  <Zap size={11} /> {t("cart.speed.priority")}
                </span>
              )}
              <StatusBadge status={order.status} />
            </div>
          </motion.div>

          {order.status !== "Delivered" && (
            <motion.div variants={fadeSlideUp} className="-mt-2 mb-4">
              <OrderSummary orderRef={orderRef} count={order.lines.reduce((n, l) => n + l.quantity, 0)} />
            </motion.div>
          )}

          <motion.div variants={fadeSlideUp}>
            <Card className="p-4">
              <OrderStatusTimeline status={order.status} cancellation={order.cancellation} />
              {order.ready_by !== null && ["Open", "BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore"].includes(order.status) && (
                <p className="mt-3 border-t border-ink-100 dark:border-ink-800 pt-3 text-xs text-ink-500">
                  {t("order.readyBy", { time: formatClockTime(order.ready_by) })}
                </p>
              )}
              {order.ready_by === null && order.prep_minutes !== null && ["Open", "BidAccepted"].includes(order.status) && (
                <p className="mt-3 border-t border-ink-100 dark:border-ink-800 pt-3 text-xs text-ink-500">
                  {t("order.prepAfterDriver", { minutes: order.prep_minutes })}
                </p>
              )}
              {order.status === "Placed" && <NetworkReach action={orderRef} />}
            </Card>
          </motion.div>

          {order.status === "Placed" && snapshot && (
            <motion.div variants={fadeSlideUp}>
              <WaitingForStore writtenAt={snapshot.writtenAt} now={snapshot.now} cancelling={action.doing === "cancel"} onCancel={cancel} />
            </motion.div>
          )}

          <motion.div variants={fadeSlideUp}>
            <Card className="mt-3 flex flex-col gap-1 p-4 text-sm">
              <p className="text-ink-500">
                <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.dropoffLabel")} </span>
                {t(DROPOFF_PREFERENCE_LABEL[order.dropoff_preference])}
              </p>
              {details?.dropoff?.line2 && (
                <p className="text-ink-500">
                  <span className="font-semibold text-ink-900 dark:text-ink-50">{t("address.line2")} </span>
                  {details.dropoff.line2}
                </p>
              )}
              {details?.dropoff?.notes && (
                <p className="text-ink-500">
                  <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.dropoffNotesLabel")} </span>
                  {details.dropoff.notes}
                </p>
              )}
              {details?.kitchen_note && (
                <p className="text-ink-500">
                  <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.storeNoteLabel")} </span>
                  {details.kitchen_note}
                </p>
              )}
              {order.tip_cents > 0 && (
                <p className="text-ink-500">
                  <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.tipLabel")} </span>
                  {formatCents(order.tip_cents)}
                </p>
              )}
            </Card>
          </motion.div>

          {order.status === "Open" && <OrderBids orderRef={orderRef} order={order} accepting={action.doing} onAccept={pickBid} />}

          {["BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore"].includes(order.status) && (
            <motion.div variants={fadeSlideUp} className="mt-5 flex items-center gap-3 rounded-2xl bg-handshake-50 dark:bg-handshake-900/20 p-4">
              <Bike size={20} className="text-handshake-600" />
              <p className="text-sm text-handshake-700 dark:text-handshake-300">{DRIVER_PROGRESS[order.status] && t(DRIVER_PROGRESS[order.status]!)}</p>
            </motion.div>
          )}

          {handoverCode && (
            <motion.div variants={fadeSlideUp} className="mt-4">
              <HandoverCode orderRef={orderRef} secret={handoverCode} />
            </motion.div>
          )}

          {!handedOver && ["BidAccepted", "MerchantConfirmed", "DriverEnRouteToMerchant", "PickedUp"].includes(order.status) && (
            <motion.div variants={fadeSlideUp} className="mt-4 flex items-start gap-3 rounded-2xl border border-ink-100 p-4 dark:border-ink-800">
              <DoorOpen size={20} className="mt-0.5 shrink-0 text-ink-400" />
              <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">
                <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.door.title")}</span> {t("order.door.detail")}
              </p>
            </motion.div>
          )}

          {order.status === "PickedUp" && (
            <motion.div variants={fadeSlideUp} className="mt-5 flex flex-col gap-3 rounded-2xl bg-handshake-50 dark:bg-handshake-900/20 p-4">
              <div className="flex items-center gap-3">
                <Bike size={20} className="text-handshake-600" />
                <p className="text-sm text-handshake-700 dark:text-handshake-300">{t("order.pickedUp")}</p>
              </div>
              {order.collateral_hold && (
                <p className="flex items-start gap-2 text-xs text-handshake-700 dark:text-handshake-300">
                  <ShieldCheck size={14} className="mt-0.5 shrink-0" />
                  {t("order.collateral", { amount: formatCents(order.order_total) })}
                </p>
              )}
              {dropoff ? (
                <p className="text-xs font-semibold text-handshake-700 dark:text-handshake-300">{t("order.handedAt", { time: formatClockTime(dropoff.at) })}</p>
              ) : handedOver ? (
                <p className="text-xs text-handshake-700 dark:text-handshake-300">
                  {t("order.confirmHint")}
                </p>
              ) : null}
              {handedOver && (
                <Button loading={action.doing === "complete"} disabled={action.busy} onClick={confirmReceipt}>
                  {t("order.haveIt")}
                </Button>
              )}
              <AnimatePresence mode="wait" initial={false}>
                {confirmingClaim ? (
                  <motion.div key="claim" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-xl bg-white p-3 dark:bg-ink-900">
                    <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">
                      {t("order.claim.warning")}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button variant="ghost" className="flex-1 py-2" onClick={() => setConfirmingClaim(false)}>
                        {t("common.back")}
                      </Button>
                      <Button variant="danger" className="flex-1 py-2" loading={action.doing === "claim"} disabled={action.busy} onClick={claimItNeverArrived}>
                        {t("order.claim.button")}
                      </Button>
                    </div>
                  </motion.div>
                ) : (
                  <motion.button key="ask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirmingClaim(true)} className="text-xs font-semibold text-handshake-700 underline-offset-4 hover:underline dark:text-handshake-300">
                    {t("order.claim.ask")}
                  </motion.button>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </div>
        <div className="lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {live && pickup && details?.dropoff && (
            <motion.div variants={fadeSlideUp} className="mt-4 lg:mt-0">
              <LiveMap orderRef={orderRef} pickup={pickup} dropoff={details.dropoff.point} />
            </motion.div>
          )}

          {live && (
            <motion.div variants={fadeSlideUp} className="mt-1">
              <ChatPanel orderRef={orderRef} title={t("order.chat")} counterpart={t("chat.driver")} />
            </motion.div>
          )}
        </div>
        <div className="min-w-0 lg:col-start-1">

          {dropoffPhoto && (
            <motion.div variants={fadeSlideUp}>
              <Card className="mt-4 p-4">
                <SectionLabel className="mb-2">{t("order.dropoffPhoto")}</SectionLabel>
                <img src={dropoffPhoto} alt={t("order.dropoffPhoto")} className="w-full rounded-xl object-cover" />
              </Card>
            </motion.div>
          )}

          <motion.div variants={fadeSlideUp}>
            <LateOrder orderRef={orderRef} order={order} storeAddress={store?.address ?? ""} onChanged={reloadOrder} />
          </motion.div>

          {collecting && (
            <motion.div variants={fadeSlideUp}>
              <Card className="mt-4 p-4">
                <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("order.collectFrom", { store: store?.name ?? t("order.theStore") })}</p>
                {store?.address && <p className="mt-0.5 text-xs text-ink-400">{store.address}</p>}
                <p className="mt-2 text-xs leading-relaxed text-ink-400">
                  {t("order.collectHint")}
                </p>
                <Button loading={action.doing === "collected"} disabled={action.busy} onClick={confirmCollectedHere} className="mt-3 w-full">
                  {t("order.gotIt")}
                </Button>
              </Card>
            </motion.div>
          )}

          {order.status === "Open" && (
            <motion.div variants={fadeSlideUp} className="mt-6">
              <Button variant="ghost" loading={action.doing === "cancel"} disabled={action.busy} onClick={cancel} className="w-full">
                {t("order.cancel")}
              </Button>
            </motion.div>
          )}

          <OrderPointsBadge orderRef={orderRef} />

          {received(order.status) && (
            <motion.div variants={fadeSlideUp}>
              <OrderIssues orderRef={orderRef} role="customer" />
              <OrderReceipt orderRef={orderRef} />
            </motion.div>
          )}

          {order.status === "Disputed" && (
            <motion.div variants={fadeSlideUp} className="mt-5 flex items-start gap-3 rounded-2xl bg-amber-50 p-4 text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">
              <AlertTriangle size={20} className="mt-0.5 shrink-0" />
              {decisions?.not_delivered ? (
                <p className="text-sm">
                  <span className="font-semibold">{t("order.refunded")}</span> {t("order.refundedDetail")}
                </p>
              ) : (
                <p className="text-sm">
                  {decisions?.claim_decided_after ? t("order.claimedBy", { time: formatDeadline(decisions.claim_decided_after) }) : t("order.claimedSoon")}
                </p>
              )}
            </motion.div>
          )}

          {received(order.status) && <RateOrder orderRef={orderRef} order={order} itemNames={itemNames} driver={driver} selfOrder={selfOrder} />}

          {action.error && <Notice className="mt-4">{action.error}</Notice>}
        </div>
      </div>
    </motion.div>
  );
}
