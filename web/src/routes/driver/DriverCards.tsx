// The driver's cards: an order they're delivering, one they could bid on,
// what their bid weighs, and the order to make their stops in -- with the
// rows and stages `Dashboard` lays them out by.
import { useState } from "react";
import { Link2, Route, ShieldCheck, Zap } from "lucide-react";
import { dropOrder, commitToOrder, weighMyBid } from "../../holochain/zomes/dispatch";
import { Sheet } from "../../components/Sheet";
import { decodeEntry, bytesToHex, hexToBytes } from "../../holochain/decode";
import { getCatalog } from "../../holochain/zomes/catalog";
import { planRoute } from "../../lib/driving/route";
import { itemCount } from "../../lib/orders/orderEntries";
import { myAgentPubKey } from "../../holochain/client";
import { encodeGeohash, geohashCenter } from "../../lib/places/geohash";
import { Button, Card, Input, Notice, SectionLabel, StatNumber } from "../../components/ui";
import { OrderStatusTimeline } from "../../components/orders/OrderStatus";
import { OrderHero } from "../../components/orders/OrderHero";
import { driverProgress } from "../../lib/orders/progress";
import { ChatPanel } from "../../components/orders/ChatPanel";
import { DriverPayHeld, OrderPayments } from "../../components/payments/OrderPayments";
import { HandoffStep } from "./HandoffStep";
import { BidWeightBreakdown, HowBidsCompare } from "../../components/orders/BidWeights";
import { StoreCheckIn, StorePickup } from "./AtTheStore";
import { getReputationSummary } from "../../holochain/zomes/reputation";
import { formatCents, formatDistance, formatEta, formatClockTime, toMinorUnits, fromMinorUnits, currencySymbol } from "../../lib/ui/format";
import { useT } from "../../i18n";
import { useResource } from "../../lib/hooks/useResource";
import { CustomerHistory } from "../../components/orders/CustomerHistory";
import type { DeliveryOrder, GeoPoint, MerchantCatalog } from "../../holochain/types";
import { estimateTrip } from "../../lib/driving/eta";
import { legMinutes } from "../../lib/driving/routing";
import { currentBeacon } from "../../lib/network/timeSource";
import { useClock } from "../../lib/hooks/useClock";
import { useDriverSettings } from "../../store/roleSettings";
import { useTerms } from "../../store/network";
import type { SentBid } from "../../store/sentBids";
import { useAction } from "../../lib/hooks/useAction";
import { DROPOFF_PREFERENCE_LABEL } from "../../lib/orders/handoffs";
import { BEFORE_PICKUP, ON_THE_WAY, dropoffPoint, type OrderRow } from "../../lib/driving/deliveryRows";

/// The order to make this driver's stops in -- see `planRoute`. Stores'
/// locations are read once per set of stores being served.
export function SuggestedRoute({ orders, location }: { orders: OrderRow[]; location: GeoPoint }) {
  const storeHexes = [...new Set(orders.map((row) => bytesToHex(row.order.catalog_ref)))].sort();
  const t = useT();
  const { data: stores } = useResource(`route-stores:${storeHexes.join(",")}`, async () => {
    const entries = await Promise.all(
      storeHexes.map(async (hex) => {
        const catalog = decodeEntry<MerchantCatalog>(await getCatalog(hexToBytes(hex)));
        return [hex, { name: catalog.business_name, at: catalog.location }] as const;
      }),
    );
    return Object.fromEntries(entries);
  });
  if (!stores) return null;

  const byHex = new Map(orders.map((row) => [bytesToHex(row.hash), row]));
  const stops = planRoute(
    location,
    orders.map((row) => ({
      id: bytesToHex(row.hash),
      pickup: row.order.status === "PickedUp" ? null : (stores[bytesToHex(row.order.catalog_ref)]?.at ?? null),
      dropoff: dropoffPoint(row),
    })),
  );
  return (
    <Card className="p-4">
      <SectionLabel icon={<Route size={13} />} className="mb-2">{t("drive.route")}</SectionLabel>
      <ol className="flex flex-col gap-1.5">
        {stops.map((stop, i) => {
          const order = byHex.get(stop.id)!.order;
          const label = stop.kind === "pickup" ? t("drive.pickUpAt", { store: stores[bytesToHex(order.catalog_ref)]?.name ?? t("order.theStore") }) : t("drive.dropOffAs", { how: t(DROPOFF_PREFERENCE_LABEL[order.dropoff_preference]) });
          return (
            <li key={`${stop.id}-${stop.kind}`} className="flex items-center gap-2 text-sm">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-handshake-500/15 text-[11px] font-bold text-handshake-600">{i + 1}</span>
              <span className="flex-1 text-ink-800 dark:text-ink-100">{label}</span>
              <span className="text-xs text-ink-400">{formatDistance(stop.legKm)}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[11px] text-ink-400">{t("drive.routeNote")}</p>
    </Card>
  );
}

export function ActiveDeliveryCard({ row, location, onAdvanced }: { row: OrderRow; location: { lat: number; lon: number }; onAdvanced: () => Promise<void> }) {
  const terms = useTerms();
  const t = useT();
  const action = useAction();
  const [dropping, setDropping] = useState(false);
  // A driver leaving an order the store has started cooking answers for the
  // food until another driver takes it on.
  const cooking = row.order.ready_by !== null;

  const run = (step: () => Promise<unknown>) => action.run(async () => {
    await step();
    await onAdvanced();
  });

  const drop = () =>
    run(async () => {
      await dropOrder(row.hash, await currentBeacon());
      setDropping(false);
    });
  const commit = () => run(() => commitToOrder(row.hash));

  return (
    <div className="flex flex-col gap-3">
    <OrderHero progress={driverProgress(row.order.status)}>
      <OrderStatusTimeline status={row.order.status} viewer="driver" />
    </OrderHero>
    <Card className="p-4">
      {row.order.ready_by !== null && BEFORE_PICKUP.includes(row.order.status) && <p className="mt-2 text-xs text-ink-500">{t("drive.readyBy", { time: formatClockTime(row.order.ready_by) })}</p>}
      {row.dropoff?.recipient && <p className="mt-2 text-sm font-semibold text-ink-900 dark:text-ink-50">{t("drive.deliverTo", { name: row.dropoff.recipient })}</p>}
      {!row.dropoff && row.order.status === "BidAccepted" && <p className="mt-2 text-xs text-ink-400">{t("drive.addressAfterCommit")}</p>}
      <p className="mt-2 text-xs font-semibold text-handshake-600">{t("order.dropoffLabel")} {t(DROPOFF_PREFERENCE_LABEL[row.order.dropoff_preference])}</p>
      {row.dropoff?.line2 && <p className="mt-1 text-sm text-ink-700 dark:text-ink-200">{row.dropoff.line2}</p>}
      {row.dropoff?.notes && (
        <p className="mt-3 rounded-lg bg-ink-100/60 dark:bg-ink-800/60 p-2.5 text-xs text-ink-500">
          <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.dropoffNotesLabel")} </span>
          {row.dropoff.notes}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-ink-400">{t("cart.deliveryFee")}</span>
          <span className="text-ink-900 dark:text-ink-50">{formatCents(row.bid?.price_offer ?? 0)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-ink-400">{t("cart.tip")}</span>
          <span className="text-ink-900 dark:text-ink-50">{formatCents(row.order.tip_cents)}</span>
        </div>
        <div className="flex items-center justify-between border-t border-ink-100 dark:border-ink-800 pt-2 mt-1">
          <span className="text-ink-400">{t("drive.totalPayout")}</span>
          <StatNumber tone="success" className="text-lg">{formatCents((row.bid?.price_offer ?? 0) + row.order.tip_cents)}</StatNumber>
        </div>
      </div>
      {/* Their collateral, held by the store; their pay, held on its card. */}
      {row.order.accepted_bid && BEFORE_PICKUP.includes(row.order.status) && (
        <div className="mt-4 flex flex-col gap-2">
          <OrderPayments order={row.hash} delivery />
          <DriverPayHeld order={row.hash} bid={row.order.accepted_bid} me={myAgentPubKey()} />
        </div>
      )}
      <div className="mt-4">
        {row.order.status === "BidAccepted" && (
          <div className="flex flex-col gap-2">
            <p className="text-center text-xs text-ink-400">{t("drive.committing", { amount: formatCents(row.order.order_total) })}</p>
            <Button variant="secondary" className="w-full" loading={action.busy} onClick={commit}>
              {t("drive.commitNow")}
            </Button>
          </div>
        )}
        {ON_THE_WAY.includes(row.order.status) && <StoreCheckIn orderRef={row.hash} order={row.order} location={location} onDone={onAdvanced} />}
        {row.order.status === "DriverAtStore" && <StorePickup orderRef={row.hash} order={row.order} location={location} onDone={onAdvanced} />}
        {(row.order.status === "PickedUp" || row.order.status === "Disputed" || row.order.status === "Unanswered") && <HandoffStep orderRef={row.hash} order={row.order} location={location} onDone={onAdvanced} />}
      </div>
      <ChatPanel orderRef={row.hash} title={t("drive.chat")} counterpart={t("chat.customer")} />
      {BEFORE_PICKUP.includes(row.order.status) && (
        <button onClick={() => setDropping(true)} className="mt-3 w-full text-center text-xs font-medium text-ink-400 hover:text-ink-600">
          {t("drive.cantMakeIt")}
        </button>
      )}
      {action.error && <Notice className="mt-3">{action.error}</Notice>}
      <Sheet
        open={dropping}
        onClose={() => setDropping(false)}
        title={t("drive.dropTitle")}
        subtitle={t("drive.dropSubtitle")}
        footer={
          <Button variant="danger" loading={action.busy} onClick={drop} className="w-full">
            {t("drive.dropIt")}
          </Button>
        }
      >
        {cooking ? (
          <p className="text-sm leading-relaxed text-ink-500">
            {t("drive.dropCooking", { minutes: Math.round(terms.replacement_window_secs / 60), amount: formatCents(row.order.order_total) })}
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-ink-500">{t("drive.dropNotCooking")}</p>
        )}
      </Sheet>
    </Card>
    </div>
  );
}

/// Sends an offer on an order, and remembers it on this device.
/// How the bid being typed would count in customers' apps, on this
/// driver's record now -- with its working a tap away.
export function MyBidWeight({ fee, etaMinutes }: { fee: number; etaMinutes: number }) {
  const t = useT();
  const { data: weight } = useResource(`my-bid-weight:${fee}:${etaMinutes}`, () => weighMyBid(fee, etaMinutes * 60));
  if (!weight) return null;
  return (
    <div className="mt-2 flex items-center gap-1 text-xs text-ink-400">
      <span>{t("bidWeight.yoursCountsAs", { amount: formatCents(weight.cost) })}</span>
      <HowBidsCompare>
        <section className="rounded-2xl bg-ink-50 p-4 dark:bg-ink-800/60">
          <p className="mb-2 text-sm font-semibold text-ink-900 dark:text-ink-50">{t("bidWeight.yourBid")}</p>
          <BidWeightBreakdown fee={fee} weight={weight} />
        </section>
      </HowBidsCompare>
    </div>
  );
}

export function BidCard({
  order,
  loading,
  sent,
  onBid,
  onWithdraw,
  sameMerchant,
  nearbyDropoffKm,
  detourKm,
  location,
}: {
  order: DeliveryOrder;
  loading: boolean;
  /// The offer this device already sent on it, if any.
  sent?: SentBid;
  onBid: (trip: { etaMinutes: number; toStoreMinutes: number }, feeCents: number) => void;
  onWithdraw: () => void;
  sameMerchant?: boolean;
  nearbyDropoffKm?: number | null;
  /// How near another drop-off counts as on the way (the network's add-on detour).
  detourKm: number;
  /// Where the driver is, for the ETA estimate.
  location: GeoPoint;
}) {
  // The ETA starts as an estimate -- there by road, waiting for the kitchen
  // if need be, then on to the drop-off -- until they type their own. With
  // no route from the network's routing service, it's theirs to type.
  const travelMode = useDriverSettings((s) => s.travelMode);
  const t = useT();
  const storeHex = bytesToHex(order.catalog_ref);
  const { data: storeAt = null } = useResource(`store-location:${storeHex}`, async () => decodeEntry<MerchantCatalog>(await getCatalog(order.catalog_ref)).location);
  // Timed again only once the driver's moved a block or so.
  const { data: legs = null } = useResource(
    storeAt ? `bid-route:${travelMode}:${encodeGeohash(location.lat, location.lon, 7)}:${storeHex}:${order.dropoff_geohash}` : null,
    () => legMinutes(travelMode, [location, storeAt!, geohashCenter(order.dropoff_geohash)]),
  );
  const now = useClock(30_000);
  const estimate = legs && estimateTrip({ toStoreMinutes: legs[0], toDropoffMinutes: legs[1], readyBy: order.ready_by, prepMinutes: order.prep_minutes, nowMs: now.getTime() });
  const [typedEta, setEta] = useState<number | null>(null);
  const eta = typedEta ?? estimate?.etaMinutes ?? null;
  // How the store treats drivers: kept them waiting, or refused to check
  // them in -- other drivers' records of it.
  const { data: store = null } = useResource(`store-record:${storeHex}`, () => getReputationSummary({ Store: order.catalog_ref }));
  // The customer's cap, which no bid may exceed -- the driver lowers it to compete.
  const [fee, setFee] = useState(order.max_delivery_fee ?? 0);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="flex items-baseline gap-1 text-sm font-bold text-ink-900 dark:text-ink-50">
          {t("order.heading")}<StatNumber className="text-base">{formatCents(order.order_total)}</StatNumber>
        </p>
        {eta !== null && <span className="text-xs text-ink-400">{formatEta(eta * 60)}</span>}
      </div>
      {sameMerchant ? (
        <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-handshake-600">
          <Link2 size={12} /> {t("drive.sameStore")}
        </p>
      ) : (
        nearbyDropoffKm !== null &&
        nearbyDropoffKm !== undefined &&
        nearbyDropoffKm <= detourKm && (
          <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-presence-600">
            <Link2 size={12} /> {nearbyDropoffKm < 0.1 ? t("drive.sameArea") : t("drive.nearOther", { distance: formatDistance(nearbyDropoffKm) })}
          </p>
        )
      )}
      <p className="mt-1 text-xs text-ink-400">
        {t("orders.items", { count: itemCount(order) })}
        {order.ready_by !== null && <span> · {t("drive.ready", { time: formatClockTime(order.ready_by) })}</span>}
        {order.tip_cents > 0 && <span className="font-semibold text-presence-600"> · {t("drive.tipAmount", { amount: formatCents(order.tip_cents) })}</span>}
      </p>
      {order.priority && (
        <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-amber-600">
          <Zap size={12} /> {t("drive.priority")}
        </p>
      )}
      <CustomerHistory customer={order.requester} />
      {store && (store.late_count > 0 || store.check_in_refused_count > 0) && (
        <p className="mt-1 text-xs font-semibold text-amber-600">
          {t("drive.storeRecord", { late: store.late_count, refused: store.check_in_refused_count })}
        </p>
      )}
      {/* Validation requires it when they commit. */}
      <p className="mt-1 flex items-center gap-1 text-xs text-ink-400">
        <ShieldCheck size={12} /> {t("drive.collateral", { amount: formatCents(order.order_total) })}
      </p>
      {sent ? (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-handshake-50 px-3 py-2 dark:bg-handshake-900/30">
          <p className="text-xs font-semibold text-handshake-700 dark:text-handshake-300">{t("drive.offerSent", { fee: formatCents(sent.feeCents), eta: formatEta(sent.etaMinutes * 60) })}</p>
          <Button variant="ghost" className="px-3 py-1.5 text-xs" loading={loading} onClick={onWithdraw}>
            {t("drive.withdraw")}
          </Button>
        </div>
      ) : (
      <div className="mt-3 flex items-center gap-2">
        <label className="flex-1 text-xs text-ink-400">
          {t("drive.eta")}
          <Input type="number" min={1} value={eta ?? ""} onChange={(e) => setEta(Math.max(1, Math.round(Number(e.target.value))))} className="mt-1 py-1.5 text-sm" />
        </label>
        <label className="flex-1 text-xs text-ink-400">
          {t("drive.yourFee")}
          <Input
            type="number"
            min={0}
            step={0.5}
            value={fromMinorUnits(fee)}
            onChange={(e) => setFee(toMinorUnits(Number(e.target.value)))}
            prefix={currencySymbol()}
            className="mt-1 py-1.5 text-sm"
          />
        </label>
        <Button className="mt-4 px-4 py-2 text-xs" loading={loading} disabled={eta === null} onClick={() => eta !== null && onBid({ etaMinutes: eta, toStoreMinutes: Math.min(estimate?.toStoreMinutes ?? eta, eta) }, fee)}>
          {t("drive.bid")}
        </Button>
      </div>
      )}
      {!sent && eta !== null && <MyBidWeight fee={fee} etaMinutes={eta} />}
    </Card>
  );
}
