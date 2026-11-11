import assert from "node:assert/strict";
import { test } from "node:test";
import { majorityOf, planWith } from "../src/routes/account/plan.ts";

const key = (n: number) => new Uint8Array(39).fill(n);

test("a plan's guardians recover it only by more than half of them, as the network requires", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(majorityOf), [1, 2, 2, 3, 3]);
  const four = [key(1), key(2), key(3), key(4)];
  assert.equal(planWith(null, { guardians: four, threshold: 2 }).threshold, 3, "two of four would let two groups each recover it");
  assert.equal(planWith(null, { guardians: four, threshold: 9 }).threshold, 4);
  assert.equal(planWith(null, { guardians: [] }).threshold, 0);
});
