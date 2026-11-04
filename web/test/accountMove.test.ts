// The code a new version of HandShake shows the previous one, to move an
// account to it: it names a network and a key, and reads back as exactly
// those -- anything else, including an account code, is no move code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountCode, moveCode, readMoveCode } from "../src/lib/account/accountMove";

const hash = (prefix: number[], fill: number) => new Uint8Array([...prefix, ...new Array(36).fill(fill)]);
const network = hash([0x84, 0x2d, 0x24], 7);
const agent = hash([0x84, 0x20, 0x24], 9);

test("a move code reads back as its network and key", () => {
  const read = readMoveCode(moveCode(network, agent));
  assert.ok(read);
  assert.deepEqual([...read.network], [...network]);
  assert.deepEqual([...read.successor], [...agent]);
  assert.ok(readMoveCode(`  ${moveCode(network, agent)}\n`), "pasted with spaces around it");
});

test("anything else isn't a move code", () => {
  assert.equal(readMoveCode(accountCode(agent)), null, "an account code names no network");
  assert.equal(readMoveCode(moveCode(agent, agent)), null, "a key where the network goes");
  assert.equal(readMoveCode(moveCode(network, network)), null, "a network where the key goes");
  assert.equal(readMoveCode(moveCode(network, agent).slice(0, -4)), null, "cut short");
  assert.equal(readMoveCode("handshake-move:"), null);
  assert.equal(readMoveCode("hello"), null);
});
