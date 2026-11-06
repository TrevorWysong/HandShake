import assert from "node:assert/strict";
import { test } from "node:test";
import { allergensChosen } from "../src/lib/storefront/choices.ts";
import { hasMatch, honestTags, matchAllergies, needsALook, parseAllergenWords, tagConflict, NO_ALLERGIES } from "../src/lib/storefront/allergens.ts";
import { bytesToHex } from "../src/holochain/decode.ts";
import type { AllergenFacts, AllergyPolicy, ModifierGroup } from "../src/holochain/types.ts";

const facts = (over: Partial<AllergenFacts> = {}) => ({ contains: [], may_contain: [], other: [], note: "", can_omit: [], ...over }) as AllergenFacts;
const policy = (over: Partial<AllergyPolicy> = {}) => ({ kitchen: [], other: [], requests: "Welcome", note: "", auto_accept_requests: false, ...over }) as AllergyPolicy;
const mine = { allergens: ["Peanuts", "Milk"] as const, other: ["Kiwi"] } as never;

test("silence is never safe, for someone with something to look out for", () => {
  const match = matchAllergies(null, null, mine);
  assert.equal(match.notStated, true);
  assert.equal(needsALook(match), true);
  assert.equal(hasMatch(match), false);
  assert.equal(needsALook(matchAllergies(null, null, NO_ALLERGIES)), false, "nobody's bothered who has nothing to look out for");
});

test("what's in it beats what may be, and a store's kitchen counts as may", () => {
  const match = matchAllergies(facts({ contains: ["Peanuts"], may_contain: ["Peanuts", "Milk"] }), policy({ kitchen: ["Milk"] }), mine);
  assert.deepEqual(match.contains, ["Peanuts"]);
  assert.deepEqual(match.mayContain, ["Milk"]);
  assert.deepEqual(matchAllergies(facts(), policy({ kitchen: ["Peanuts"] }), mine).mayContain, ["Peanuts"]);
});

test("a stated none isn't silence, and isn't a match", () => {
  const match = matchAllergies(facts(), policy(), mine);
  assert.equal(match.notStated, false);
  assert.equal(needsALook(match), false);
});

test("a store's own words match someone's own, in any case, and only exactly", () => {
  assert.deepEqual(matchAllergies(facts({ other: [" KIWI "] }), null, mine).containsOther, ["Kiwi"]);
  assert.deepEqual(matchAllergies(facts({ other: ["Kiwifruit"] }), null, mine).containsOther, []);
  assert.deepEqual(matchAllergies(facts(), policy({ other: ["kiwi"] }), mine).mayContainOther, ["Kiwi"]);
});

test("what a choice adds counts as in it", () => {
  assert.deepEqual(matchAllergies(facts(), null, mine, { contains: ["Milk"], other: ["Kiwi"] }).contains, ["Milk"]);
  assert.deepEqual(matchAllergies(facts(), null, mine, { contains: [], other: ["Kiwi"] }).containsOther, ["Kiwi"]);
  const groupRef = new Uint8Array(39).fill(1);
  const nestedRef = new Uint8Array(39).fill(2);
  const group = (id: number, contains: string[], other: string[]): ModifierGroup => ({ catalog_ref: groupRef, name: "", min_selections: 0, max_selections: null, max_per_option: 1, free_selections: 0, options: [{ id, name: "", price_cents: 0, available: true, nested_group: null, contains, other_allergens: other } as never] });
  const groups = new Map([[bytesToHex(groupRef), group(1, ["Milk"], [])], [bytesToHex(nestedRef), group(2, ["Soy"], ["Kiwi"])]]);
  const chosen = allergensChosen([{ group: groupRef, options: [{ option: 1, quantity: 1, nested: [{ group: nestedRef, options: [{ option: 2, quantity: 1, nested: [] }] }] }] }], groups);
  assert.deepEqual(chosen, { contains: ["Milk", "Soy"], other: ["Kiwi"] });
});

test("words as typed are tidied, once each and within the limit", () => {
  assert.deepEqual(parseAllergenWords(" Kiwi, ,garlic, KIWI "), ["Kiwi", "garlic"]);
  assert.equal(parseAllergenWords("a,b,c,d,e,f,g,h,i,j").length, 8);
});

test("a tag its own statement contradicts doesn't reach a customer", () => {
  assert.equal(tagConflict("Gluten-free", facts({ contains: ["Gluten"] })), true);
  assert.equal(tagConflict("Vegan", facts({ contains: ["Milk"] })), true);
  assert.equal(tagConflict("Vegan", facts({ may_contain: ["Milk"] })), false, "a shared kitchen isn't a contradiction");
  assert.equal(tagConflict("Spicy", facts({ contains: ["Milk"] })), false);
  assert.equal(tagConflict("Vegan", null), false, "nothing said, nothing contradicted");
  assert.deepEqual(honestTags(["Vegan", "Spicy"], facts({ contains: ["Eggs"] })), ["Spicy"]);
});
