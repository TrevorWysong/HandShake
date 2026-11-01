// A reward redeemed into the bag: its own free line, one reward a bag, and
// out again with its line -- the same rules the cart screens show.
import assert from "node:assert/strict";
import test from "node:test";
import { cartItems, lineKey, useCart, type CartLine } from "../src/store/cart.ts";
import { rewardDiscount, rewardLine } from "../src/lib/rewards/rewards.ts";
import type { Reward } from "../src/holochain/types.ts";
import type { ItemRow } from "../src/lib/storefront/menu.ts";

const store = new Uint8Array([1, 2, 3]);
const owner = new Uint8Array([9]);
const bread = new Uint8Array([7]);
const soup = new Uint8Array([8]);
const line = (itemRef: Uint8Array, priceCents: number, quantity = 1): CartLine => ({ itemRef, name: "x", basePriceCents: priceCents, priceCents, quantity, selections: [], choiceLabels: [] });
const menu = [{ hash: bread, version: bread, item: { name: "Bread", price_cents: 400 } }] as unknown as ItemRow[];
const freeBread: Reward = { id: 1, name: "Free bread", cost: 100, benefit: { FreeItem: { item_ref: bread, quantity: 1 } }, min_tier: 0 };
const fiveOff: Reward = { id: 2, name: "$5 off", cost: 300, benefit: { FlatOffSubtotal: 500 }, min_tier: 0 };

test("a redeemed item is a free line of its own, and the order counts it with any paid ones", () => {
  const cart = useCart.getState();
  cart.clear();
  cart.addLine(store, owner, "Mo's", line(bread, 400));
  cart.addLine(store, owner, "Mo's", line(soup, 1000));
  cart.redeem(store, owner, "Mo's", { id: 1, name: "Free bread", cost: 100 }, rewardLine(freeBread, menu));
  const { lines, reward } = useCart.getState();
  assert.equal(reward?.cost, 100, "its points are held");
  assert.equal(lines.length, 3, "kept apart from the bread they pay for");
  assert.notEqual(lineKey(lines[0]), lineKey(lines[2]));
  assert.deepEqual(cartItems(lines).map((i) => [i.item_ref[0], i.quantity]), [[7, 2], [8, 1]], "one item, both units, for the order");
  assert.equal(rewardDiscount(freeBread.benefit, lines), 400, "one bread free");
  useCart.getState().setQuantity(lineKey(lines[2]), 5);
  assert.equal(useCart.getState().lines[2].quantity, 1, "a reward's line holds what it gives, no more");
});

test("one reward a bag: another replaces it, and taking it out frees its points", () => {
  const cart = useCart.getState();
  cart.redeem(store, owner, "Mo's", { id: 2, name: "$5 off", cost: 300 }, rewardLine(fiveOff, menu));
  assert.equal(useCart.getState().reward?.id, 2);
  assert.equal(useCart.getState().lines.filter((l) => l.rewardId != null).length, 0, "the bread reward's line goes with it");
  cart.redeem(store, owner, "Mo's", { id: 1, name: "Free bread", cost: 100 }, rewardLine(freeBread, menu));
  const rewardKey = lineKey(useCart.getState().lines.find((l) => l.rewardId != null)!);
  useCart.getState().removeLine(rewardKey);
  assert.equal(useCart.getState().reward, null, "removing its line releases the reward");
  cart.redeem(store, owner, "Mo's", { id: 1, name: "Free bread", cost: 100 }, rewardLine(freeBread, menu));
  useCart.getState().addLine(new Uint8Array([4]), owner, "Elsewhere", line(soup, 1000));
  assert.equal(useCart.getState().reward, null, "a bag from another store holds no reward of this one's");
});
