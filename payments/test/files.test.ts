// The agent's files on disk: replaced whole or not at all, and its owner's
// alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCredentials, type Sealer } from "../src/credentials.ts";
import { emptyState, fileStore } from "../src/state.ts";

const keys = (account: string) => ({ processor: "Stripe" as const, keys: { publishable_key: "pk", restricted_key: `rk_${account}` }, connection: { account, live: false, currency: "USD", publicKey: `pk_${account}`, publicAccount: "", country: "" } });

test("processor keys are replaced whole, sealed, and readable only by their owner", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "handshake-keys-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "payments", "keys.sealed");
  const sealer: Sealer = { seal: async (plain) => Buffer.from(plain).reverse(), open: async (sealed) => Buffer.from(sealed).reverse().toString() };
  const store = fileCredentials(path, sealer);
  await store.save(keys("first"));
  await store.save(keys("second"));
  assert.equal((await store.load())?.connection.account, "second", "replaced");
  assert.ok(!(await readFile(path, "utf8")).includes("rk_second"), "sealed on disk");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(dir, "payments")), ["keys.sealed"], "nothing left beside it");

  // A write a crash cut short leaves its half beside the file, never in it.
  await writeFile(`${path}.next`, "half a fi");
  assert.equal((await store.load())?.connection.account, "second", "the keys kept are whole");
  await store.save(keys("third"));
  assert.equal((await store.load())?.connection.account, "third", "and the next save replaces the half");
  await store.clear();
  assert.equal(await store.load(), null);
});

test("the agent's state is replaced whole too", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "handshake-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  const store = fileStore(path);
  await store.save({ ...emptyState(), account: "Stripe:pk:" });
  await writeFile(`${path}.next`, "{\"half");
  assert.equal((await store.load()).account, "Stripe:pk:");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("clearing keys deletes them for good, and clearing none is no error", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "handshake-clear-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sealer: Sealer = { seal: async (plain) => Buffer.from(plain), open: async (sealed) => Buffer.from(sealed).toString() };
  const store = fileCredentials(join(dir, "payments", "keys.sealed"), sealer);
  await store.clear();
  await store.save(keys("first"));
  await store.clear();
  assert.equal(await store.load(), null);
  assert.deepEqual(await readdir(join(dir, "payments")), [], "nothing left");
});
