import assert from "node:assert/strict";
import { test } from "node:test";
import { goodwillChoices, partIn, pointsIn, quickParts } from "../src/lib/orders/issueAnswer.ts";
import { MAX_GRANT_POINTS } from "../src/holochain/types.ts";

test("quick parts: a quarter, half and three quarters, whole and strictly between", () => {
  assert.deepEqual(quickParts(1000), [250, 500, 750]);
  assert.deepEqual(quickParts(3), [1, 2]);
  assert.deepEqual(quickParts(1), [], "a report worth one cent has no part");
});

test("a part typed is more than nothing and less than all of it", () => {
  assert.equal(partIn(400, 1000), 400);
  assert.equal(partIn(0, 1000), null);
  assert.equal(partIn(1000, 1000), null);
  assert.equal(partIn(12.5, 1000), null);
});

test("goodwill: the cheapest rewards' costs, or round amounts", () => {
  const reward = (name: string, cost: number) => ({ id: 0, name, cost }) as never;
  assert.deepEqual(goodwillChoices([reward("Cake", 900), reward("Coffee", 300), reward("Cookie", 300), reward("Tea", 500), reward("Huge", MAX_GRANT_POINTS + 1)]), [
    { points: 300, reward: "Coffee" },
    { points: 500, reward: "Tea" },
    { points: 900, reward: "Cake" },
  ]);
  assert.deepEqual(goodwillChoices([]).map((c) => c.points), [50, 100, 250]);
});

test("points typed: whole, between 1 and the most a grant gives", () => {
  assert.equal(pointsIn(250), 250);
  assert.equal(pointsIn(0), null);
  assert.equal(pointsIn(MAX_GRANT_POINTS + 1), null);
  assert.equal(pointsIn(2.5), null);
});
