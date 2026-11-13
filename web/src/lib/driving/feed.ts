// A driver's side of the network, as their app reads and answers it: the
// deliveries they're carrying, the orders open near them, and the bids they
// send -- by hand, or by their rule (`autoBid`) as new orders come in.
import { getMyActiveDeliveries, getOpenOrdersNear, getOrderPrivateDetails, submitBid } from "../../holochain/zomes/dispatch";
import { getCatalog } from "../../holochain/zomes/catalog";
import { getCustomerScore, getReputationSummary } from "../../holochain/zomes/reputation";
import { actionHash, bytesEqual, bytesToHex, decodeEntry } from "../../holochain/decode";
import type { Bid, DeliveryOrder, GeoPoint, MerchantCatalog, NetworkTerms, Party } from "../../holochain/types";
import { geohashCenter } from "../places/geohash";
import { useDriverSettings } from "../../store/roleSettings";
import { useSentBids } from "../../store/sentBids";
import { stillSignedIn } from "../../store/identityScope";
import { offerable, offerRules, type Commitment } from "./addOns";
import { autoBidPrice, quote, skipsStore } from "./autoBid";
import { estimateTrip } from "./eta";
import { legMinutes } from "./routing";
import { commitmentOf, type OrderRow } from "./deliveryRows";
import { blockedAmong } from "../reputation/blockCache";
import { below } from "../reputation/customers";
import { storeLocations } from "./storeLocations";

/// The deliveries this driver is carrying, from their own active-delivery
/// queue -- bounded by what they carry now, never by every bid they've
/// placed -- each with its exact drop-off, opened for them.
export async function fetchActiveDeliveries(): Promise<OrderRow[]> {
  const rows: OrderRow[] = await Promise.all(
    (await getMyActiveDeliveries()).map(async ({ order, bid }) => ({
      hash: order.original_action,
      order: decodeEntry<DeliveryOrder>(order.record),
      bid: decodeEntry<Bid>(bid),
      dropoff: (await getOrderPrivateDetails(order.original_action).catch(() => null))?.dropoff ?? null,
    })),
  );
  return withStores(rows);
}

/// `rows`, each with where its store is -- read together, and kept.
async function withStores(rows: OrderRow[]): Promise<OrderRow[]> {
  const located = await storeLocations(rows.map(({ order }) => order.catalog_ref));
  return rows.map((row) => ({ ...row, store: located.get(bytesToHex(row.order.catalog_ref)) ?? null }));
}

/// The orders open near `geohash` that `driver` may bid on. A customer or
/// store can't deliver their own order (validate_new_bid refuses it), so
/// they're never offered one; nor is one from a customer or store the
/// driver's blocked with, either way (docs/REPUTATION.md, phase 4) -- read
/// from the kept answers, since this polls, while bidding checks for itself.
export async function fetchOffered(geohash: string, driver: Uint8Array): Promise<OrderRow[]> {
  const rows = (await getOpenOrdersNear(geohash)).map((record) => ({ hash: actionHash(record), order: decodeEntry<DeliveryOrder>(record) }));
  const theirs = rows.filter(({ order }) => !bytesEqual(order.requester, driver) && !bytesEqual(order.merchant, driver));
  const me: Party = { Person: driver };
  const pairs = theirs.flatMap(({ order }): [Party, Party][] => [[me, { Person: order.requester }], [me, { Store: order.catalog_ref }]]);
  // A read that fails leaves the feed as it is rather than empty: bidding
  // still refuses a blocked pair.
  const blocked = await blockedAmong(pairs).catch(() => pairs.map(() => false));
  return withStores(theirs.filter((_, i) => !blocked[i * 2] && !blocked[i * 2 + 1]));
}

/// Sends a bid, kept as this device's to take back.
export async function sendBid(driverHex: string, orderRef: Uint8Array, trip: { etaMinutes: number; toStoreMinutes: number }, feeCents: number): Promise<void> {
  const current = stillSignedIn();
  const record = await submitBid({
    order_ref: orderRef,
    eta_seconds: trip.etaMinutes * 60,
    to_store_seconds: Math.min(trip.toStoreMinutes, trip.etaMinutes) * 60,
    price_offer: feeCents,
  });
  // Kept for the driver who sent it, never under whoever's signed in since.
  if (current()) useSentBids.getState().record(driverHex, bytesToHex(orderRef), { bid: bytesToHex(actionHash(record)), feeCents, etaMinutes: trip.etaMinutes, sentAt: Date.now() });
}

/// Orders this device has bid on by itself, by driver and order, so no read
/// bids twice (the network refuses a second bid regardless).
const autoBidOn = new Set<string>();

/// Bids on each offered order the driver's rule takes, at their fee --
/// skipping stores other drivers keep reporting, and any order the routing
/// service can't time (its ETA is the driver's to type). What they're
/// carrying is `carried` if it's been read, and read only when the rule's on
/// and there's an order it hasn't tried.
export async function bidAutomatically(driverHex: string, offered: OrderRow[], carried: OrderRow[] | undefined, location: GeoPoint, terms: NetworkTerms): Promise<void> {
  const { autoBid, fees, limits, travelMode } = useDriverSettings.getState();
  const keyOf = (orderRef: Uint8Array) => `${driverHex}:${bytesToHex(orderRef)}`;
  const untried = offered.filter(({ hash }) => !autoBidOn.has(keyOf(hash)));
  if (!autoBid.on || untried.length === 0) return;
  const carrying: Commitment[] = (carried ?? (await fetchActiveDeliveries())).map(commitmentOf);
  for (const { hash: orderRef, order } of offerable(untried, carrying, offerRules(terms, limits))) {
    autoBidOn.add(keyOf(orderRef));
    try {
      const [catalog, store] = await Promise.all([getCatalog(order.catalog_ref), getReputationSummary({ Store: order.catalog_ref })]);
      if (skipsStore(store.check_in_refused_count, autoBid)) continue;
      // A customer below the driver's own threshold, if they set one.
      if (autoBid.skipBelowCustomerScore !== null && below(await getCustomerScore(order.requester).catch(() => null), autoBid.skipBelowCustomerScore)) continue;
      const storeAt = decodeEntry<MerchantCatalog>(catalog).location;
      const dropoffAt = geohashCenter(order.dropoff_geohash);
      const price = autoBidPrice(quote({ driver: location, store: storeAt, dropoff: dropoffAt }, fees, limits.minFeeCents), order.max_delivery_fee);
      if (price === null) continue;
      const legs = await legMinutes(travelMode, [location, storeAt, dropoffAt]);
      if (!legs) continue;
      const trip = estimateTrip({ toStoreMinutes: legs[0], toDropoffMinutes: legs[1], readyBy: order.ready_by, prepMinutes: order.prep_minutes, nowMs: Date.now() });
      await sendBid(driverHex, orderRef, trip, price);
    } catch {
      // Already bid, or the order moved on: nothing to do.
    }
  }
}
