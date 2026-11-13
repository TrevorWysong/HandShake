import assert from "node:assert/strict";
import { test } from "node:test";
import { blockPrint, blocksPerson, listsKey } from "../src/lib/reputation/blockPrints.ts";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

test("a fingerprint is the network's: the same vector the Rust test checks", async () => {
  const print = await blockPrint(new Uint8Array(16).fill(7), new Uint8Array(39).fill(9));
  assert.equal(hex(print), "b7cfd6e51ba00d3635e9b6c2d1b973186ecb9462643faf26dc20f6732c841051");
});

test("a list finds only who's in it, under its own salt", async () => {
  const salt = new Uint8Array(16).fill(1);
  const list = new Uint8Array(32 * 8);
  list.set(await blockPrint(salt, new Uint8Array(39).fill(2)), 32 * 3);
  assert.equal(await listsKey(list, salt, new Uint8Array(39).fill(2)), true);
  assert.equal(await listsKey(list, salt, new Uint8Array(39).fill(3)), false);
  assert.equal(await listsKey(list, new Uint8Array(16), new Uint8Array(39).fill(2)), false);
  assert.equal(await listsKey(new Uint8Array(), salt, new Uint8Array(39).fill(2)), false);
});

test("a person in one's own list", () => {
  const key = new Uint8Array([1, 2, 3]);
  assert.equal(blocksPerson([{ Store: key }, { Person: new Uint8Array([1, 2, 3]) }], key), true);
  assert.equal(blocksPerson([{ Store: key }], key), false);
});
