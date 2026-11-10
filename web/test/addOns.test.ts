import assert from "node:assert/strict";
import { test } from "node:test";
import { offerable, offerRefusal, offerRules, type Commitment } from "../src/lib/driving/addOns.ts";
import { carryRefusal } from "../src/lib/driving/driverLoad.ts";
import { encodeGeohash } from "../src/lib/places/geohash.ts";
import type { DeliveryOrder, GeoPoint } from "../src/holochain/types.ts";

const NETWORK = { max_concurrent_deliveries: 3, add_on_detour_km: 2 };
const TERMS = offerRules(NETWORK, { maxAtOnce: null, takePriority: true, minFeeCents: 0, detourKm: null });
const HOME: GeoPoint = { lat: 27.7676, lon: -82.6403 };
// About 1km and 20km north.
const NEAR: GeoPoint = { lat: 27.7766, lon: -82.6403 };
const FAR: GeoPoint = { lat: 27.9476, lon: -82.6403 };
const STORE_A = new Uint8Array([1]);
const STORE_B = new Uint8Array([2]);

function order(fields: { store?: Uint8Array; to?: GeoPoint; priority?: boolean; status?: DeliveryOrder["status"] }): DeliveryOrder {
  const to = fields.to ?? HOME;
  return {
    catalog_ref: fields.store ?? STORE_A,
    dropoff_geohash: encodeGeohash(to.lat, to.lon, 6),
    priority: fields.priority ?? false,
    status: fields.status ?? "Open",
    max_delivery_fee: null,
  } as DeliveryOrder;
}
const open = (o: DeliveryOrder) => ({ order: o });
const carrying = (o: DeliveryOrder, dropoff: GeoPoint = HOME, store: GeoPoint | null = null): Commitment => ({ order: o, dropoff, store });

test("a driver with nothing on is offered every order, priority included", () => {
  const orders = [open(order({ to: FAR })), open(order({ priority: true }))];
  assert.equal(offerable(orders, [], TERMS).length, 2);
});

test("while delivering, only add-ons: near a drop-off, or from a store still to collect from", () => {
  const delivering = [carrying(order({ store: STORE_A, status: "DriverEnRouteToMerchant" }))];
  const nearby = open(order({ store: STORE_B, to: NEAR }));
  const sameStore = open(order({ store: STORE_A, to: FAR }));
  const elsewhere = open(order({ store: STORE_B, to: FAR }));
  assert.deepEqual(offerable([nearby, sameStore, elsewhere], delivering, TERMS), [nearby, sameStore]);
});

test("a store already collected from isn't a reason to add an order", () => {
  const delivering = [carrying(order({ store: STORE_A, status: "PickedUp" }))];
  assert.deepEqual(offerable([open(order({ store: STORE_A, to: FAR }))], delivering, TERMS), []);
});

test("priority orders go only to a driver with nothing on, and alone", () => {
  const delivering = [carrying(order({}))];
  assert.deepEqual(offerable([open(order({ priority: true }))], delivering, TERMS), []);
  const onPriority = [carrying(order({ priority: true }))];
  assert.deepEqual(offerable([open(order({}))], onPriority, TERMS), []);
  assert.equal(offerRefusal(onPriority, TERMS), "CarryingPriority");
});

test("nothing more past the network's limit", () => {
  const full = [carrying(order({})), carrying(order({})), carrying(order({}))];
  assert.equal(offerRefusal(full, TERMS), "AtLimit");
  assert.deepEqual(offerable([open(order({}))], full, TERMS), []);
  assert.equal(offerRefusal(full.slice(1), TERMS), null);
});

test("carryRefusal mirrors the network's rule", () => {
  assert.equal(carryRefusal({ orders: 0, priority: false }, true, 3), null);
  assert.equal(carryRefusal({ orders: 1, priority: false }, true, 3), "PriorityGoesAlone");
  assert.equal(carryRefusal({ orders: 1, priority: true }, false, 3), "CarryingPriority");
  assert.equal(carryRefusal({ orders: 3, priority: false }, false, 3), "AtLimit");
});

test("a driver's own limits narrow what they're offered, never widen it", () => {
  const one = offerRules(NETWORK, { maxAtOnce: 1, takePriority: false, minFeeCents: 500, detourKm: null });
  assert.equal(one.maxAtOnce, 1);
  assert.equal(offerRules(NETWORK, { maxAtOnce: 9, takePriority: true, minFeeCents: 0, detourKm: null }).maxAtOnce, 3, "never past the network's limit");
  assert.equal(offerRefusal([carrying(order({}))], one), "AtLimit");
  const cheap = { ...order({}), max_delivery_fee: 300 };
  const fair = { ...order({}), max_delivery_fee: 600 };
  const uncapped = { ...order({}), max_delivery_fee: null };
  assert.deepEqual(offerable([open(cheap), open(fair), open(uncapped), open(order({ priority: true }))], [], one), [open(fair), open(uncapped)]);
});

test("a driver's own add-on distance narrows or widens what's on their way", () => {
  const delivering = [carrying(order({ status: "PickedUp" }), HOME)];
  const nearby = [open(order({ store: STORE_B, to: NEAR }))];
  assert.equal(offerable(nearby, delivering, TERMS).length, 1, "1 km is within the network's 2 km");
  assert.equal(offerable(nearby, delivering, offerRules(NETWORK, { maxAtOnce: null, takePriority: true, minFeeCents: 0, detourKm: 0.5 })).length, 0, "but not within their own half a km");
  assert.equal(offerable([open(order({ store: STORE_B, to: FAR }))], delivering, offerRules(NETWORK, { maxAtOnce: null, takePriority: true, minFeeCents: 0, detourKm: 5 })).length, 0, "and 20 km is beyond any");
});

test("a store near one still to collect from batches, as DoorDash does; one far off, or already collected from, doesn't", () => {
  // Collecting from store A, at HOME, for a drop-off far away.
  const collecting = carrying(order({ store: STORE_A, to: FAR, status: "MerchantConfirmed" }), FAR, HOME);
  const fromNearStore = { order: order({ store: STORE_B, to: { lat: 27.5, lon: -82.9 } }), store: NEAR };
  const fromFarStore = { order: order({ store: STORE_B, to: { lat: 27.5, lon: -82.9 } }), store: FAR };
  assert.equal(offerable([fromNearStore], [collecting], TERMS).length, 1, "about 1 km from the pickup, within the 2 km add-on distance");
  assert.equal(offerable([fromFarStore], [collecting], TERMS).length, 0, "20 km off isn't on the way");
  assert.equal(offerable([{ ...fromNearStore, store: null }], [collecting], TERMS).length, 0, "a store not yet located isn't assumed near");
  const collected = carrying(order({ store: STORE_A, to: FAR, status: "PickedUp" }), FAR, HOME);
  assert.equal(offerable([fromNearStore], [collected], TERMS).length, 0, "once collected, its store's neighbourhood isn't on the way");
  const tight = offerRules(NETWORK, { maxAtOnce: null, takePriority: true, minFeeCents: 0, detourKm: 0.5 });
  assert.equal(offerable([fromNearStore], [collecting], tight).length, 0, "and the driver's own add-on distance holds for stores too");
});
