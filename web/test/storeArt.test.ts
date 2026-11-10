import assert from "node:assert/strict";
import { test } from "node:test";
import { storeArt } from "../src/lib/storefront/storeArt.ts";

test("a store's look follows what its cuisine says it serves, in either language", () => {
  assert.equal(storeArt("ab", "Mexican").emoji, "🌮");
  assert.equal(storeArt("ab", "Taco bar").emoji, "🌮");
  assert.equal(storeArt("ab", "Comida mexicana").emoji, "🌮");
  assert.equal(storeArt("ab", "Café").emoji, "☕");
  assert.equal(storeArt("ab", "American").emoji, "🍔");
  assert.equal(storeArt("ab", "Pizzería").emoji, "🍕");
});

test("and is the same store's every time, on any screen", () => {
  assert.deepEqual(storeArt("84ef01", "Fusion"), storeArt("84ef01", "Fusion"));
  assert.deepEqual(storeArt("84ef01", null).gradient, storeArt("84ef01", "Mexican").gradient);
});
