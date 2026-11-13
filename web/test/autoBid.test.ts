import assert from "node:assert/strict";
import { test } from "node:test";
import { autoBidPrice, quote, skipsStore } from "../src/lib/driving/autoBid.ts";
import { defaultSchedule, type FeeSchedule } from "../src/lib/driving/feeSchedule.ts";

// About 1 km apart, along a meridian.
const driver = { lat: 0, lon: 0 };
const store = { lat: 0.009, lon: 0 };
const dropoff = { lat: 0.072, lon: 0 };
const rate: FeeSchedule = { ...defaultSchedule("km"), kind: "rate", perUnitCents: 100, baseCents: 0 };

test("a driver's fee is their rate for the trip: to the store, then on", () => {
  const q = quote({ driver, store, dropoff }, rate, 0)!;
  assert.ok(Math.abs(q.km - 8) < 0.05);
  assert.equal(q.feeCents, Math.ceil(q.km * 100));
});

test("or only the store to the drop-off", () => {
  const q = quote({ driver, store, dropoff }, { ...rate, measure: "delivery" }, 0)!;
  assert.ok(Math.abs(q.km - 7) < 0.05);
});

test("never under their lowest fee, never zero", () => {
  assert.equal(quote({ driver, store, dropoff }, rate, 5000)!.feeCents, 5000);
  assert.equal(quote({ driver, store: driver, dropoff: driver }, rate, 0)!.feeCents, 1);
});

test("never over the customer's cap: no bid at all", () => {
  assert.equal(autoBidPrice({ km: 7.2, feeCents: 720 }, 700), null);
  assert.equal(autoBidPrice({ km: 7.2, feeCents: 720 }, 720), 720);
  assert.equal(autoBidPrice({ km: 7.2, feeCents: 720 }, null), 720);
});

test("past the last band with nothing set beyond it, no bid", () => {
  const bands: FeeSchedule = { ...rate, kind: "bands", bands: [{ upTo: 3, feeCents: 400 }], beyondPerUnitCents: null };
  assert.equal(quote({ driver, store, dropoff }, bands, 0), null);
  assert.equal(autoBidPrice(null, null), null);
});

test("a place that isn't one gets no quote, never a fee of NaN", () => {
  assert.equal(quote({ driver: { lat: Number.NaN, lon: 0 }, store, dropoff }, rate, 0), null);
});

test("a store drivers keep reporting is skipped", () => {
  const rule = { on: true, skipRefusals: 3, skipBelowCustomerScore: null };
  assert.equal(skipsStore(2, rule), false);
  assert.equal(skipsStore(3, rule), true);
});
