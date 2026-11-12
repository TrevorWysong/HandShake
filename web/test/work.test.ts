// The work a payer's app does for a store seeing cards tested hashes just as
// the zome checks it (dispatch_types::work_bits): the same vector, worked
// out apart from both with Python's BLAKE2b-256.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findWork, leadingZeroBits, workHash } from "../src/lib/payments/work";

const hash = (prefix: number[], fill: number) => new Uint8Array([...prefix, ...new Array(36).fill(fill)]);
const payer = hash([0x84, 0x20, 0x24], 1);
const payee = hash([0x84, 0x20, 0x24], 2);
const busy = hash([0x84, 0x29, 0x24], 3);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("the app hashes work as the zome does", () => {
  assert.equal(hex(workHash(payer, payee, busy, 12_345)), "dd9058dde6d44b814a85fd1b9b98fed4e1b3d1aa11a6f10edba5c1deb99db778");
  assert.equal(leadingZeroBits(workHash(payer, payee, busy, 902)), 12);
});

test("it finds the first nonce that does the work asked, for that payee", async () => {
  const proof = await findWork(payer, { payee, busy, bits: 12 });
  assert.equal(proof.nonce, 902, "the same nonce the zome's vector proves");
  assert.ok(leadingZeroBits(workHash(payee, payer, busy, proof.nonce)) < 12, "bound to who pays whom");
});

test("leading zero bits count across bytes", () => {
  assert.equal(leadingZeroBits(new Uint8Array([0, 0, 0x10, 0xff])), 19);
  assert.equal(leadingZeroBits(new Uint8Array([0x80])), 0);
  assert.equal(leadingZeroBits(new Uint8Array([0, 0])), 16);
});
