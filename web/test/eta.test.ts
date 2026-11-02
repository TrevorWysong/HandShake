import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTrip } from "../src/lib/driving/eta.ts";

const NOW = 1_800_000_000_000;
// Half an hour by road to the store, half an hour on.
const trip = { toStoreMinutes: 30, toDropoffMinutes: 30, readyBy: null, prepMinutes: null, nowMs: NOW };

test("an ETA is the road time to the store and on to the drop-off", () => {
  assert.deepEqual(estimateTrip(trip), { toStoreMinutes: 30, etaMinutes: 60 });
});

test("a driver who'd arrive before the food is ready waits for it", () => {
  const readyIn45 = (NOW + 45 * 60_000) * 1000;
  // 30 minutes there, but the food's ready at 45; then 30 minutes on.
  assert.deepEqual(estimateTrip({ ...trip, readyBy: readyIn45 }), { toStoreMinutes: 30, etaMinutes: 75 });
});

test("before the kitchen starts, the food's ready its quoted prep time from now", () => {
  assert.deepEqual(estimateTrip({ ...trip, prepMinutes: 50 }), { toStoreMinutes: 30, etaMinutes: 80 });
});

test("an ETA is never under a minute", () => {
  assert.deepEqual(estimateTrip({ ...trip, toStoreMinutes: 0.2, toDropoffMinutes: 0 }), { toStoreMinutes: 1, etaMinutes: 1 });
});

test("a restaurant card's estimate: prep, any busy extra, and the drive, rounded, with a driver's spread", async () => {
  const { deliveryEstimate } = await import("../src/lib/driving/eta");
  const here = { lat: 27.7676, lon: -82.6403 };
  const store = { location: { lat: 27.8126, lon: -82.6403 }, prep_minutes: 15, busy_extra_minutes: 0 };
  // 15 prep + 12 by road = 27 -> 25.
  const near = deliveryEstimate(store, here, 12);
  assert.deepEqual([near.fromMinutes, near.toMinutes], [25, 35]);
  assert.ok(Math.abs(near.km - 5) < 0.1);
  const busy = deliveryEstimate({ ...store, busy_extra_minutes: 20 }, here, 12);
  assert.deepEqual([busy.fromMinutes, busy.toMinutes], [45, 55], "a busy kitchen says so");
  const unrouted = deliveryEstimate(store, here, null);
  assert.deepEqual([unrouted.fromMinutes, unrouted.toMinutes], [null, null], "no drive time, no guess");
  assert.ok(Math.abs(unrouted.km - 5) < 0.1, "but still how far");
});

test("distances read in the local unit", async () => {
  const { formatDistance } = await import("../src/lib/ui/format");
  assert.equal(formatDistance(1.234, "en-US"), "0.8 mi");
  assert.equal(formatDistance(1.234, "en-GB"), "0.8 mi");
  assert.equal(formatDistance(1.234, "de-DE"), "1,2 km");
  assert.equal(formatDistance(12.6, "fr-FR"), "13 km");
});
