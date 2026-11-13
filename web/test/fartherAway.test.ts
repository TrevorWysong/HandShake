import assert from "node:assert/strict";
import { test } from "node:test";
import { fartherThanKm } from "../src/lib/storefront/fartherAway.ts";

test("too few stores to compare: none is farther away", () => {
  assert.equal(fartherThanKm([1, 2, 20]), null);
});

test("twice the median of the stores shown", () => {
  assert.equal(fartherThanKm([2, 3, 4, 5, 30]), 8);
  assert.equal(fartherThanKm([2, 3, 5, 9]), 8);
});

test("never nearer than a few km, however near the rest", () => {
  assert.equal(fartherThanKm([0.2, 0.3, 0.4, 0.5]), 3);
});
