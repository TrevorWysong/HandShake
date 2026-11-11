// What's kept for whoever is signed in stays theirs: another identity on the
// same device starts afresh, and the first finds theirs as they left it.
import assert from "node:assert/strict";
import test from "node:test";

// This device's storage, as a browser has it.
const kept = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) },
});
const { signedIn, stillSignedIn } = await import("../src/store/identityScope.ts");
const { useCarts } = await import("../src/store/cart.ts");
const { useGuardianNames } = await import("../src/store/guardianNames.ts");

const store = new Uint8Array([1, 2, 3]);
const bread = { itemRef: new Uint8Array([7]), name: "Bread", basePriceCents: 300, priceCents: 300, choiceCharges: [], quantity: 2, selections: [], choiceLabels: [] };
const settle = () => new Promise((r) => setTimeout(r, 0));

test("another identity on this device sees none of the last one's cart or guardian names", async () => {
  signedIn("aa");
  await settle();
  useCarts.getState().addLine(store, new Uint8Array([9]), "Mo's", bread);
  useGuardianNames.getState().setName("key1", "Mum");

  signedIn("bb");
  await settle();
  assert.deepEqual(useCarts.getState().carts, {}, "a new identity has no carts");
  assert.deepEqual(useGuardianNames.getState().names, {}, "and nobody's guardians are named");

  signedIn("aa");
  await settle();
  assert.equal(Object.values(useCarts.getState().carts)[0]?.lines.length, 1, "the first finds their cart as they left it");
  assert.equal(useGuardianNames.getState().names.key1, "Mum");
});

test("nothing is written for nobody, and signing out keeps each identity's copy", async () => {
  signedIn(null);
  await settle();
  assert.deepEqual(useCarts.getState().carts, {}, "signed out, nothing shows");
  assert.ok([...kept.keys()].every((k) => k.endsWith(":aa") || k.endsWith(":bb")), "everything kept is under an identity");
});

test("switching identities quickly, without waiting for anything to read back, never shows one person's to another", async () => {
  signedIn("cc");
  useCarts.getState().addLine(store, new Uint8Array([9]), "Mo's", bread);
  useGuardianNames.getState().setName("key2", "Dad");
  // Back and forth, with no pause for any store to settle.
  for (const who of ["dd", "cc", "dd", null, "dd"] as const) signedIn(who);
  assert.deepEqual(useCarts.getState().carts, {}, "the last one in has none of cc's cart");
  assert.deepEqual(useGuardianNames.getState().names, {}, "nor cc's guardians");
  await settle();
  assert.deepEqual(useCarts.getState().carts, {}, "nor once anything reading back has finished");
  signedIn("cc");
  await settle();
  assert.equal(Object.values(useCarts.getState().carts)[0]?.lines.length, 1, "and cc's are still theirs");
  assert.equal(useGuardianNames.getState().names.key2, "Dad");
});

test("a read that answers after another identity signs in, or after signing out, is known to be stale", () => {
  signedIn("ee");
  const forEe = stillSignedIn();
  assert.ok(forEe(), "still ee's");
  signedIn("ee");
  assert.ok(forEe(), "signing the same identity in again changes nothing");
  signedIn("ff");
  assert.ok(!forEe(), "ff signed in: ee's read is dropped");
  const forFf = stillSignedIn();
  signedIn(null);
  assert.ok(!forFf(), "signed out: ff's read is dropped");
  signedIn("ff");
  assert.ok(!forFf(), "and stays dropped when ff signs back in -- it was asked before");
});
