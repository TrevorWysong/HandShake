import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLine, choicesToKeep } from "../src/lib/storefront/cartCheck.ts";
import type { Groups } from "../src/lib/storefront/choices.ts";
import type { ItemRow } from "../src/lib/storefront/menu.ts";
import type { CartLine } from "../src/store/cart.ts";
import { bytesToHex } from "../src/holochain/decode.ts";
import type { MenuItem, ModifierGroup } from "../src/holochain/types.ts";

const hash = (n: number) => new Uint8Array(39).fill(n);
const STORE = hash(200);
const LATTE = hash(1);
const SIZE = hash(10);

function item(price_cents: number, more: Partial<MenuItem> = {}): MenuItem {
  return { catalog_ref: STORE, name: "Latte", price_cents, available: true, description: "", photo_data_uri: "", category: "", allergens: null, sale: null, dietary_tags: [], modifier_groups: [SIZE], tax_category: "", age_restricted: false, ...more };
}
const size = (large: number, largeOnOffer = true): ModifierGroup => ({
  catalog_ref: STORE, name: "Size", min_selections: 1, max_selections: 1, max_per_option: 1, free_selections: 0,
  options: [
    { id: 1, name: "Small", price_cents: 0, available: true, nested_group: null, contains: [], other_allergens: [] },
    { id: 2, name: "Large", price_cents: large, available: largeOnOffer, nested_group: null, contains: [], other_allergens: [] },
  ],
});
const groups = (g: ModifierGroup): Groups => new Map([[bytesToHex(SIZE), g]]);
const row = (i: MenuItem): ItemRow => ({ hash: LATTE, version: hash(2), item: i });
/// A large latte, as it went into the cart: $4.00 and 75¢ for large.
const line: CartLine = {
  itemRef: LATTE, name: "Latte", basePriceCents: 400, priceCents: 475, quantity: 1,
  choiceCharges: [{ group: bytesToHex(SIZE), units: [{ option: 2, cents: 75 }] }],
  selections: [{ group: SIZE, options: [{ option: 2, quantity: 1, nested: [] }] }], choiceLabels: ["Large"],
};

test("a line as it was added is fine", () => {
  assert.deepEqual(checkLine(line, [row(item(400))], groups(size(75)), null), { kind: "ok" });
});

test("a new price for the item or a choice reprices the line, choices kept", () => {
  const dearer = checkLine(line, [row(item(450))], groups(size(75)), null);
  assert.equal(dearer.kind, "repriced");
  assert.equal(dearer.kind === "repriced" && dearer.line.priceCents, 525);
  const choice = checkLine(line, [row(item(400))], groups(size(100)), null);
  assert.equal(choice.kind === "repriced" && choice.line.priceCents, 500);
  assert.equal(choice.kind === "repriced" && choice.line.selections, line.selections, "the same choices");
});

test("an item taken off the menu or sold out can't be ordered", () => {
  assert.equal(checkLine(line, [], groups(size(75)), null).kind, "gone");
  assert.equal(checkLine(line, [row(item(400, { available: false }))], groups(size(75)), null).kind, "gone");
});

test("choices that no longer fit are chosen again", () => {
  assert.equal(checkLine(line, [row(item(400))], groups(size(75, false)), null).kind, "choose", "an option no longer on offer");
  assert.equal(checkLine(line, [row(item(400, { modifier_groups: [] }))], new Map(), null).kind, "choose", "a group the item no longer offers");
  assert.equal(checkLine(line, [row(item(400))], new Map(), null).kind, "choose", "a group gone from the store");
});

test("a reward's line stays free; only its item going matters", () => {
  const reward = { ...line, rewardId: 3 };
  assert.deepEqual(checkLine(reward, [row(item(999))], groups(size(75)), null), { kind: "ok" });
  assert.equal(checkLine(reward, [], groups(size(75)), null).kind, "gone");
});

test("a goodie bag its store ended can't be ordered; unread bags aren't judged", () => {
  const bag = { ...line, bag: { pickup: true, delivery: true, closes: 0 } } as unknown as CartLine;
  assert.equal(checkLine(bag, [], new Map(), new Set()).kind, "gone");
  assert.deepEqual(checkLine(bag, [], new Map(), new Set([bytesToHex(LATTE)])), { kind: "ok" });
  assert.deepEqual(checkLine(bag, [], new Map(), null), { kind: "ok" });
});

test("choosing again keeps what still fits and lets go of what doesn't", () => {
  const kept = choicesToKeep(item(400), line.selections, groups(size(75, false)));
  assert.deepEqual(kept[0].options, [], "large is off: unchosen, for the customer to choose again");
  assert.deepEqual(choicesToKeep(item(400), line.selections, groups(size(75)))[0].options, line.selections[0].options, "still on offer: kept");
  const regrouped = choicesToKeep(item(400, { modifier_groups: [hash(11), SIZE] }), line.selections, groups(size(75)));
  assert.deepEqual(regrouped.map((s) => s.options.length), [0, 0], "groups changed: afresh, in the item's order");
});
