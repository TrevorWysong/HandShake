import assert from "node:assert/strict";
import { test } from "node:test";
import { bandProblem, defaultSchedule, feeFor, KM_PER_MILE, MAX_BANDS, orderedBands, soundSchedule, type FeeSchedule } from "../src/lib/driving/feeSchedule.ts";

const bands: FeeSchedule = {
  ...defaultSchedule("mi"),
  kind: "bands",
  bands: [
    { upTo: 3, feeCents: 400 },
    { upTo: 6, feeCents: 600 },
    { upTo: 10, feeCents: 900 },
  ],
  beyondPerUnitCents: 150,
};
const miles = (mi: number) => mi * KM_PER_MILE;

test("a rate: a flat part and so much a unit, rounded up", () => {
  const rate: FeeSchedule = { ...bands, kind: "rate", baseCents: 200, perUnitCents: 150 };
  assert.equal(feeFor(miles(4), rate), 200 + 600);
  assert.equal(feeFor(miles(0.5), rate), 200 + 75);
  assert.equal(feeFor(4, { ...rate, unit: "km" }), 200 + 600);
});

test("bands: each from where the one before ends, its end included", () => {
  assert.equal(feeFor(0, bands), 400);
  assert.equal(feeFor(miles(3), bands), 400);
  assert.equal(feeFor(miles(3.1), bands), 600);
  assert.equal(feeFor(miles(10), bands), 900);
});

test("past the last band: its fee and so much a unit beyond, or nothing", () => {
  assert.equal(feeFor(miles(12), bands), 900 + 300);
  assert.equal(feeFor(miles(12), { ...bands, beyondPerUnitCents: null }), null);
  assert.equal(feeFor(1, { ...bands, bands: [] }), null);
});

test("a band out of order is flagged and left out until it's put right", () => {
  const typed = [{ upTo: 3, feeCents: 400 }, { upTo: 2, feeCents: 999 }, { upTo: 6, feeCents: 600 }];
  assert.equal(bandProblem(typed, 0), null);
  assert.equal(bandProblem(typed, 1), "notPastPrevious");
  assert.equal(bandProblem(typed, 2), null);
  assert.deepEqual(orderedBands(typed).map((b) => b.upTo), [3, 6]);
  assert.equal(feeFor(miles(2.5), { ...bands, bands: typed }), 400);
});

test("a saved schedule is made sound: amounts, distances, at most ten bands", () => {
  const fallback = defaultSchedule("km");
  const junk = soundSchedule({ kind: "nope", unit: "mi", baseCents: -5, perUnitCents: 12.6, beyondPerUnitCents: "x", bands: [{ upTo: 0, feeCents: 1 }, { upTo: 9999, feeCents: Infinity }, { upTo: 2.04, feeCents: 300 }, ...Array.from({ length: 20 }, () => ({ upTo: 1, feeCents: 1 }))] }, fallback);
  assert.equal(junk.kind, fallback.kind);
  assert.equal(junk.unit, "mi");
  assert.equal(junk.baseCents, fallback.baseCents);
  assert.equal(junk.perUnitCents, 13);
  assert.equal(junk.beyondPerUnitCents, fallback.beyondPerUnitCents);
  assert.ok(junk.bands.length <= MAX_BANDS);
  assert.deepEqual(junk.bands[0], { upTo: 2, feeCents: 300 });
  assert.equal(soundSchedule({ beyondPerUnitCents: null }, fallback).beyondPerUnitCents, null);
  assert.deepEqual(soundSchedule(undefined, fallback), fallback);
});
