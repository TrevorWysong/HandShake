import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilters, isNarrowed, matches, NO_FILTERS, readFilters, writeFilters, type BrowseFilters, type StoreFacts } from "../src/lib/storefront/browseFilters.ts";

const store = (over: Partial<StoreFacts> = {}): StoreFacts => ({ name: "Mo's", searchable: "Mo's Mexican tacos", cuisine: "Mexican", diets: ["Vegan"], rating: 4.2, reviewCount: 3, open: true, favorite: false, deal: false, minutes: 30, km: 2, ...over });
const on = (over: Partial<BrowseFilters>) => ({ ...NO_FILTERS, ...over });

test("filters survive the address, and only ever as what they can be", () => {
  const filters = on({ query: "taco", cuisine: "Mexican", diets: ["Vegan", "Halal"], deals: true, openNow: true, favorites: true, minRating: 4, maxMinutes: 30, sort: "rating" });
  assert.deepEqual(readFilters(new URLSearchParams(writeFilters(filters).toString())), filters);
  assert.deepEqual(readFilters(new URLSearchParams("rating=1&time=999&sort=evil&deals=yes")), NO_FILTERS);
  assert.equal(writeFilters(NO_FILTERS).toString(), "");
});

test("a minimum rating leaves out stores below it, and those nobody's reviewed", () => {
  assert.equal(matches(store({ rating: 4.2 }), on({ minRating: 4 })), true);
  assert.equal(matches(store({ rating: 3.9 }), on({ minRating: 4 })), false);
  assert.equal(matches(store({ rating: 0, reviewCount: 0 }), on({ minRating: 3.5 })), false);
  assert.equal(matches(store({ rating: 4.5 }), on({ minRating: 4.5 })), true);
});

test("a time limit promises nothing of a store with no estimate", () => {
  assert.equal(matches(store({ minutes: 30 }), on({ maxMinutes: 30 })), true);
  assert.equal(matches(store({ minutes: 35 }), on({ maxMinutes: 30 })), false);
  assert.equal(matches(store({ minutes: null }), on({ maxMinutes: 60 })), false);
});

test("every filter narrows together, and every diet chosen must hold", () => {
  assert.equal(matches(store(), on({ query: "MEXICAN taco", cuisine: "Mexican", diets: ["Vegan"] })), true);
  assert.equal(matches(store(), on({ query: "pizza" })), false);
  assert.equal(matches(store(), on({ diets: ["Vegan", "Halal"] })), false);
  assert.equal(matches(store({ deal: false }), on({ deals: true })), false);
  assert.equal(matches(store({ open: false }), on({ openNow: true })), false);
  assert.equal(matches(store(), on({ favorites: true })), false);
});

test("open stores come first, then the chosen order, with no estimate last", () => {
  const stores = [store({ name: "Closed", open: false, rating: 5, minutes: 5, km: 0 }), store({ name: "B", rating: 3, minutes: null, km: 3 }), store({ name: "A", rating: 4.5, minutes: 40, km: 5 })];
  const names = (sort: BrowseFilters["sort"]) => applyFilters(stores, (s) => s, on({ sort })).map((s) => s.name);
  assert.deepEqual(names("rating"), ["A", "B", "Closed"]);
  assert.deepEqual(names("fastest"), ["A", "B", "Closed"]);
  assert.deepEqual(names("nearest"), ["B", "A", "Closed"]);
  assert.deepEqual(names("name"), ["A", "B", "Closed"]);
  assert.deepEqual(names("relevance"), ["B", "A", "Closed"]);
});

test("the order of a list doesn't count as narrowing it", () => {
  assert.equal(isNarrowed(on({ sort: "rating" })), false);
  assert.equal(isNarrowed(on({ openNow: true })), true);
});
