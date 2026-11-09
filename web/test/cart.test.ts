// A cart per store, as the big apps keep them; and a reward redeemed into
// one: its own free line, one reward a cart, and out again with its line --
// the same rules the cart screens show.
import assert from "node:assert/strict";
import test from "node:test";
import { cartItems, cartKey, cartView, lineKey, MAX_CARTS, useCarts, type CartLine } from "../src/store/cart.ts";
import { plainRewardLine, rewardDiscount, rewardItem } from "../src/lib/rewards/rewards.ts";
import type { Reward } from "../src/holochain/types.ts";
import type { ItemRow } from "../src/lib/storefront/menu.ts";

const store = new Uint8Array([1, 2, 3]);
const owner = new Uint8Array([9]);
const bread = new Uint8Array([7]);
const soup = new Uint8Array([8]);
const line = (itemRef: Uint8Array, priceCents: number, quantity = 1): CartLine => ({ itemRef, name: "x", basePriceCents: priceCents, priceCents, choiceCharges: [], quantity, selections: [], choiceLabels: [] });
const menu = [{ hash: bread, version: bread, item: { name: "Bread", price_cents: 400 } }] as unknown as ItemRow[];
const freeBread: Reward = { id: 1, name: "Free bread", cost: 100, benefit: { FreeItem: { item_ref: bread, quantity: 1, choices: [] } }, min_tier: 0 };
/// The line a reward puts in the bag, as the redeem screens do for an item
/// with nothing to choose.
const rewardLine = (reward: Reward, rows: ItemRow[]) => {
  const gift = rewardItem(reward, rows);
  return gift && plainRewardLine(gift);
};
/// A store's cart as a screen has it.
const cartOf = (catalogRef: Uint8Array) => {
  const key = cartKey(catalogRef);
  const { carts, promos } = useCarts.getState();
  return cartView(key, carts[key], promos[key] ?? null);
};
const empty = () => useCarts.setState({ carts: {}, promos: {} });
const fiveOff: Reward = { id: 2, name: "$5 off", cost: 300, benefit: { FlatOffSubtotal: 500 }, min_tier: 0 };

test("a redeemed item is a free line of its own, and the order counts it with any paid ones", () => {
  empty();
  const carts = useCarts.getState();
  carts.addLine(store, owner, "Mo's", line(bread, 400));
  carts.addLine(store, owner, "Mo's", line(soup, 1000));
  carts.redeem(store, owner, "Mo's", { id: 1, name: "Free bread", cost: 100 }, rewardLine(freeBread, menu));
  const { lines, reward } = cartOf(store);
  assert.equal(reward?.cost, 100, "its points are held");
  assert.equal(lines.length, 3, "kept apart from the bread they pay for");
  assert.notEqual(lineKey(lines[0]), lineKey(lines[2]));
  assert.deepEqual(cartItems(lines).map((i) => [i.item_ref[0], i.quantity]), [[7, 2], [8, 1]], "one item, both units, for the order");
  assert.equal(rewardDiscount(freeBread.benefit, lines), 400, "one bread free");
  cartOf(store).setQuantity(lineKey(lines[2]), 5);
  assert.equal(cartOf(store).lines[2].quantity, 1, "a reward's line holds what it gives, no more");
});

test("one reward a cart: another replaces it, and taking it out frees its points", () => {
  const carts = useCarts.getState();
  carts.redeem(store, owner, "Mo's", { id: 2, name: "$5 off", cost: 300 }, rewardLine(fiveOff, menu));
  assert.equal(cartOf(store).reward?.id, 2);
  assert.equal(cartOf(store).lines.filter((l) => l.rewardId != null).length, 0, "the bread reward's line goes with it");
  carts.redeem(store, owner, "Mo's", { id: 1, name: "Free bread", cost: 100 }, rewardLine(freeBread, menu));
  const rewardKey = lineKey(cartOf(store).lines.find((l) => l.rewardId != null)!);
  cartOf(store).removeLine(rewardKey);
  assert.equal(cartOf(store).reward, null, "removing its line releases the reward");
});

test("each store keeps its own cart: adding from another never touches this one", () => {
  empty();
  const elsewhere = new Uint8Array([4]);
  const carts = useCarts.getState();
  carts.addLine(store, owner, "Mo's", line(bread, 400));
  carts.redeem(store, owner, "Mo's", { id: 1, name: "Free bread", cost: 100 }, rewardLine(freeBread, menu));
  carts.addLine(elsewhere, owner, "Elsewhere", line(soup, 1000));
  assert.equal(Object.keys(useCarts.getState().carts).length, 2);
  assert.equal(cartOf(store).reward?.id, 1, "its reward, and its held points, stay with it");
  assert.equal(cartOf(store).count, 2);
  assert.equal(cartOf(elsewhere).total(), 1000);
  cartOf(elsewhere).clear();
  assert.equal(cartOf(store).count, 2, "ordering from one empties only that one");
});

test("a promo can be chosen before anything's in its store's cart, and goes with the cart", () => {
  empty();
  useCarts.getState().choosePromo(cartKey(store), "abc");
  assert.equal(cartOf(store).promoHex, "abc");
  useCarts.getState().addLine(store, owner, "Mo's", line(bread, 400));
  assert.equal(cartOf(store).promoHex, "abc");
  cartOf(store).clear();
  assert.equal(cartOf(store).promoHex, null);
});

test("a cart emptied of its last line goes, and the oldest goes past the limit", () => {
  empty();
  const carts = useCarts.getState();
  carts.addLine(store, owner, "Mo's", line(bread, 400));
  cartOf(store).removeLine(lineKey(line(bread, 400)));
  assert.equal(Object.keys(useCarts.getState().carts).length, 0);
  for (let i = 0; i <= MAX_CARTS; i++) carts.addLine(new Uint8Array([100 + i]), owner, `Store ${i}`, line(bread, 400));
  const kept = useCarts.getState().carts;
  assert.equal(Object.keys(kept).length, MAX_CARTS);
  assert.equal(kept[cartKey(new Uint8Array([100]))], undefined, "the one left longest");
});
