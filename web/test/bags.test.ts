// Goodie bags in the cart: one of each to an order, and checkout naming a
// bag the order can't have as it stands -- the network's own rules
// (dispatch_integrity::checks::bag_line_problem), told first.
import assert from "node:assert/strict";
import test from "node:test";
import { cartKey, cartView, lineKey, menuLines, useCarts } from "../src/store/cart.ts";
import { bagLine, bagProblems } from "../src/lib/storefront/bags.ts";
import type { GoodieBag } from "../src/holochain/types.ts";

const store = new Uint8Array([1, 2, 3]);
const owner = new Uint8Array([9]);
const HOUR = 3_600_000_000;
const bag = (pickup: boolean, delivery: boolean): GoodieBag =>
  ({ title: "Pastry bag", price_cents: 600, original_value_cents: 1800, supports_pickup: pickup, supports_delivery: delivery, pickup_window_end: 10 * HOUR }) as GoodieBag;
const pastries = bagLine({ hash: new Uint8Array([5]), bag: bag(true, false) });

test("a goodie bag is one to an order, and isn't a menu line", () => {
  useCarts.setState({ carts: {}, promos: {} });
  const key = cartKey(store);
  const cart = () => cartView(key, useCarts.getState().carts[key], null);
  useCarts.getState().addLine(store, owner, "Cara's", pastries);
  useCarts.getState().addLine(store, owner, "Cara's", pastries);
  cart().setQuantity(lineKey(pastries), 3);
  assert.deepEqual(cart().lines.map((l) => l.quantity), [1], "adding again, or more, keeps one");
  assert.equal(menuLines(cart().lines).length, 0, "promos, rewards and the minimum don't count it");
});

test("checkout names a bag the order can't have", () => {
  const now = 9 * HOUR;
  assert.deepEqual(bagProblems([pastries], false, now), [], "picked up, as it's offered");
  assert.deepEqual(bagProblems([pastries], true, now).map((p) => p.closed), [false], "delivered: pickup only");
  assert.deepEqual(bagProblems([pastries], false, 10 * HOUR).map((p) => p.closed), [true], "its window has closed");
  const both = bagLine({ hash: new Uint8Array([6]), bag: bag(true, true) });
  assert.deepEqual(bagProblems([both], true, now), [], "offered both ways");
});
