import assert from "node:assert/strict";
import { test } from "node:test";
import { below, CUSTOMER_REASONS, CUSTOMER_REASON_LABEL, sameParty, scorePercent } from "../src/lib/reputation/customers.ts";

const score = (up: number, down: number, shown = true) => ({ up, down, reasons: [], shown });

test("a score is a share of thumbs up, once shown", () => {
  assert.equal(scorePercent(score(9, 1)), 90);
  assert.equal(scorePercent(score(2, 1)), 66, "rounded down: never flattered");
  assert.equal(scorePercent(score(9, 1, false)), null, "not shown before enough ratings");
  assert.equal(scorePercent(score(0, 0)), null);
});

test("no score is never a low score: thresholds pass new customers", () => {
  assert.equal(below(score(7, 3), 80), true);
  assert.equal(below(score(8, 2), 80), false, "at the threshold isn't below it");
  assert.equal(below(score(0, 3, false), 80), false, "too few ratings to judge");
  assert.equal(below(null, 80), false);
  assert.equal(below(score(0, 10), null), false, "no threshold chosen");
});

test("parties compare by key, people apart from stores", () => {
  const key = new Uint8Array([1, 2, 3]);
  assert.equal(sameParty({ Person: key }, { Person: new Uint8Array([1, 2, 3]) }), true);
  assert.equal(sameParty({ Person: key }, { Store: key }), false);
});

test("every reason has its words", () => {
  for (const reason of CUSTOMER_REASONS) assert.ok(CUSTOMER_REASON_LABEL[reason]);
});
