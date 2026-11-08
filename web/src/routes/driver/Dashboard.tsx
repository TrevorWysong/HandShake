import { Bike, MapPin, Power, Route } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { withdrawBid } from "../../holochain/zomes/dispatch";
import { bytesToHex, hexToBytes } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { encodeGeohash, distanceKm, geohashCenter } from "../../lib/places/geohash";
import { useSession } from "../../store/session";
import { Card, EmptyState, Notice, PresenceDot, Skeleton } from "../../components/ui";
import { StarRating } from "../../components/StarRating";
import { averageRating, getRatingSummary } from "../../holochain/zomes/reputation";
import { useT } from "../../i18n";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { useLocalSignal, useResource } from "../../lib/hooks/useResource";
import type { DeliveryOrder } from "../../holochain/types";
import { POLL, isOrderSignal } from "../../lib/network/poll";
import { offerable, offerRefusal, offerRules, type Commitment } from "../../lib/driving/addOns";
import { useDriverSettings } from "../../store/roleSettings";
import { DriverSettingsCard } from "./DriverSettingsCard";
import { VerificationCard } from "./VerificationCard";
import { useTerms } from "../../store/network";
import { useSentBids } from "../../store/sentBids";
import { resetFeed, useDriverFeed } from "../../store/driverFeed";
import { fetchActiveDeliveries, sendBid } from "../../lib/driving/feed";
import { unlockChime } from "../../lib/ui/chime";
import { useAction } from "../../lib/hooks/useAction";
import { ActiveDeliveryCard, BidCard, SuggestedRoute } from "./DriverCards";
import { dropoffPoint } from "../../lib/driving/deliveryRows";

export function DriverDashboard() {
  const location = useSession((s) => s.location);
  const t = useT();
  const me = useSession((s) => s.agentPubKey);
  const driverKey = myAgentPubKey();
  const driverHex = bytesToHex(driverKey);
  const sentBids = useSentBids((s) => s.sent);
  useLocalSignal((signal) => {
    if ("BidReleased" in signal) useSentBids.getState().forgetBid(bytesToHex(signal.BidReleased));
  });
  const online = useDriverFeed((s) => s.driver === driverHex);
  // One offer at a time, sent or taken back, named by its order.
  const bidding = useAction();
  // Driver ratings only -- if this agent also runs a store, that store's
  // reviews live on the store, never here.
  const { data: rating } = useResource(`driver-rating:${driverHex}`, () => getRatingSummary({ Driver: driverKey }));
  const avgRating = rating ? averageRating(rating) : null;

  const terms = useTerms();
  const geohash = encodeGeohash(location.lat, location.lon);

  // This driver's in-progress deliveries, from their own active-delivery
  // queue -- bounded by what they're carrying right now.
  const { data: activeOrders = [], reload: reloadActive } = useResource(`driver-active:${driverHex}`, fetchActiveDeliveries, {
    pollMs: POLL.signalled,
    refreshOn: (s) => "BidAccepted" in s || "BidReleased" in s || isOrderSignal(s),
  });

  // Open orders near them, read by the app's feed while they're online
  // (`DriverFeed`) -- here only once it's read where they are now.
  const nearby = useDriverFeed((s) => (s.driver === driverHex && s.geohash === geohash ? s.offered : undefined));

  function toggleOnline() {
    // Going online is the tap that lets the page ring for new orders.
    if (!online) unlockChime();
    resetFeed(online ? null : driverHex);
  }

  const placeBid = (orderRef: Uint8Array, trip: { etaMinutes: number; toStoreMinutes: number }, feeCents: number) =>
    bidding.run(() => sendBid(driverHex, orderRef, trip, feeCents), { as: bytesToHex(orderRef) });

  /// Takes back the offer this device sent on an order.
  function withdraw(orderRef: Uint8Array) {
    const orderHex = bytesToHex(orderRef);
    const offer = sentBids[`${driverHex}:${orderHex}`];
    if (!offer) return;
    return bidding.run(async () => {
      await withdrawBid(hexToBytes(offer.bid));
      useSentBids.getState().forget(driverHex, orderHex);
    }, { as: orderHex });
  }

  // Order batching -- a client-side
  // convenience sort, not real route optimization: there's no way to
  // deterministically validate "is this a good route" inside a zome, and
  // that remains a deliberately open gap. Two zero-fetch signals, both
  // already present on every DeliveryOrder: an exact catalog_ref match
  // (literally the same pickup stop) and drop-off proximity to an order
  // already accepted (clustered drop-offs -- e.g. the same apartment
  // complex), so a driver already committed to one or two deliveries sees
  // the genuinely convenient next pickup first, without this app ever
  // claiming to have computed an optimal route.
  const sameMerchantHexes = new Set(activeOrders.map((r) => bytesToHex(r.order.catalog_ref)));
  // An open order is known only by its area; the deliveries already
  // accepted, exactly.
  function nearestActiveDropoffKm(order: DeliveryOrder): number | null {
    if (activeOrders.length === 0) return null;
    const area = geohashCenter(order.dropoff_geohash);
    return Math.min(...activeOrders.map((a) => distanceKm(area, dropoffPoint(a))));
  }
  // What this driver has taken on decides what they're offered: add-ons on
  // their way while they're delivering, nothing past their limit.
  const ownLimits = useDriverSettings((s) => s.limits);
  const rules = offerRules(terms, ownLimits);
  const commitments: Commitment[] = activeOrders.map((row) => ({ order: row.order, dropoff: dropoffPoint(row) }));
  const refusal = offerRefusal(commitments, rules);
  const sortedNearby = online && nearby
    ? offerable(nearby, commitments, rules).sort((a, b) => {
        const aSame = sameMerchantHexes.has(bytesToHex(a.order.catalog_ref));
        const bSame = sameMerchantHexes.has(bytesToHex(b.order.catalog_ref));
        if (aSame !== bSame) return aSame ? -1 : 1;
        const aDist = nearestActiveDropoffKm(a.order) ?? Infinity;
        const bDist = nearestActiveDropoffKm(b.order) ?? Infinity;
        return aDist - bDist;
      })
    : null;

  // On a wide screen: going online beside what they take on, then what
  // they're carrying beside what's on offer.
  const carrying = activeOrders.length > 0;
  return (
    <div className="px-4 pt-4 pb-8">
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-5">
        <Card className="mb-5 flex items-center justify-between p-4 lg:order-1">
          <div>
            <p className="flex items-center gap-2 text-sm font-bold text-ink-900 dark:text-ink-50">
              <PresenceDot live={online} />
              {online ? t("drive.online") : t("drive.offline")}
            </p>
            <p className="text-xs text-ink-400">{online ? t("drive.onlineDetail") : t("drive.offlineDetail")}</p>
            {avgRating !== null && rating && <StarRating value={avgRating} count={rating.count} size={11} />}
          </div>
          <motion.button
            onClick={toggleOnline}
            aria-label={online ? t("drive.goOffline") : t("drive.goOnline")}
            whileTap={{ scale: 0.92 }}
            animate={{ backgroundColor: online ? "#22c55e" : "#ece9e6" }}
            transition={{ duration: 0.25 }}
            className={`grid h-11 w-11 place-items-center rounded-full ${online ? "text-white shadow-[var(--shadow-glow)]" : "text-ink-400"}`}
            style={online ? { boxShadow: "0 6px 20px -4px rgba(34, 197, 94, 0.5)" } : undefined}
          >
            <Power size={20} />
          </motion.button>
        </Card>
        {me && (
          <div className="lg:order-3 lg:col-span-2">
            <VerificationCard me={me} />
          </div>
        )}
        <div className="lg:order-2">
          <DriverSettingsCard />
        </div>
      </div>

      <div className={clsx(carrying && online && "lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-5")}>
        <AnimatePresence initial={false}>
          {carrying && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mb-5 flex flex-col gap-4">
              <p className="text-xs font-bold uppercase tracking-wide text-handshake-600">
                {t("drive.active", { count: activeOrders.length })}
              </p>
              {activeOrders.length > 1 && <SuggestedRoute orders={activeOrders} location={location} />}
              {activeOrders.map((row) => (
                <motion.div key={bytesToHex(row.hash)} layout variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0, scale: 0.97 }}>
                  <ActiveDeliveryCard row={row} location={location} onAdvanced={reloadActive} />
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <div>
          {online && refusal === null && (
            <>
              <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-ink-400">
                <MapPin size={14} className="text-handshake-500" />
                {carrying ? t("drive.addOns") : t("drive.nearby")}
              </div>
              {sortedNearby === null && (
                <div className={clsx("grid gap-3", !carrying && "lg:grid-cols-2")}>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Card key={i} className="p-4">
                      <Skeleton className="h-4 w-1/3 mb-2" />
                      <Skeleton className="h-3 w-2/3 mb-3" />
                      <Skeleton className="h-8 w-full" />
                    </Card>
                  ))}
                </div>
              )}
              {sortedNearby?.length === 0 &&
                (!carrying ? (
                  <EmptyState icon={<Bike size={28} />} title={t("drive.noneNearby")} subtitle={t("drive.noneNearbyDetail")} />
                ) : (
                  <EmptyState icon={<Route size={28} />} title={t("drive.noAddOns")} subtitle={t("drive.noAddOnsDetail")} />
                ))}
              <motion.div variants={staggerContainer} initial="hidden" animate="visible" className={clsx("grid gap-3 lg:items-start", !carrying && "lg:grid-cols-2")}>
                {sortedNearby?.map(({ hash, order }) => (
                  <motion.div key={bytesToHex(hash)} variants={fadeSlideUp} layout>
                    <BidCard
                      order={order}
                      loading={bidding.doing === bytesToHex(hash)}
                      sent={sentBids[`${driverHex}:${bytesToHex(hash)}`]}
                      onBid={(trip, fee) => placeBid(hash, trip, fee)}
                      onWithdraw={() => withdraw(hash)}
                      sameMerchant={sameMerchantHexes.has(bytesToHex(order.catalog_ref))}
                      nearbyDropoffKm={nearestActiveDropoffKm(order)}
                      detourKm={rules.detourKm}
                      location={location}
                    />
                  </motion.div>
                ))}
              </motion.div>
            </>
          )}

          {online && refusal !== null && (
            <p className="rounded-xl bg-ink-100/60 dark:bg-ink-800/60 px-4 py-3 text-center text-xs text-ink-400">
              {refusal === "CarryingPriority" ? t("drive.onPriority") : t("drive.atLimit", { count: rules.maxAtOnce })}
            </p>
          )}
        </div>
      </div>

      {bidding.error && <Notice className="mt-4">{bidding.error}</Notice>}
    </div>
  );
}
