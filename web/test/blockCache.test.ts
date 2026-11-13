import assert from "node:assert/strict";
import { test } from "node:test";
import { pairKey } from "../src/lib/reputation/blockCache.ts";

test("a pair's key is the same either way round, and people apart from stores", () => {
  const a = new Uint8Array([1, 2]);
  const b = new Uint8Array([3, 4]);
  assert.equal(pairKey({ Person: a }, { Store: b }), pairKey({ Store: b }, { Person: a }));
  assert.notEqual(pairKey({ Person: a }, { Person: b }), pairKey({ Person: a }, { Store: b }));
});
