import assert from "node:assert/strict";
import { test } from "node:test";
import { storesOrderedFrom } from "../src/lib/orders/orderAgain.ts";

const order = (store: number) => ({ order: { catalog_ref: new Uint8Array([store]) } });

test("each store once, newest order first, and no more than the row holds", () => {
  const stores = (orders: ReturnType<typeof order>[], max?: number) => storesOrderedFrom(orders, max).map((ref) => ref[0]);
  assert.deepEqual(stores([order(3), order(1), order(3), order(2), order(1)]), [3, 1, 2]);
  assert.deepEqual(stores([order(1), order(2), order(3)], 2), [1, 2]);
  assert.deepEqual(stores([]), []);
});
