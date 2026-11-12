// One payment agent per identity: its folder is held from start to stop,
// and a second agent -- in this process or another -- is refused rather
// than run alongside, so two never authorize the same offer or save their
// state over each other's. A lock left by a process that died is taken
// over, so a crash never locks an account out.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.ts";
import { processorFor } from "../src/adapters/index.ts";
import { memoryCredentials } from "../src/credentials.ts";
import { LOCK_FILE, holdFolder, holderFrom, startOf } from "../src/lock.ts";
import { fileStore } from "../src/state.ts";

const folder = () => mkdtemp(path.join(tmpdir(), "handshake-agent-"));

test("a folder is held by one at a time, and free again once let go", async () => {
  const dir = await folder();
  const release = await holdFolder(dir);
  await assert.rejects(holdFolder(dir), /already running for this account/, "a second holder in this process is refused");
  const lock = JSON.parse(await readFile(path.join(dir, `${LOCK_FILE}.1`), "utf8")) as { pid: number };
  assert.equal(lock.pid, process.pid, "the lock names its process");
  await release();
  const again = await holdFolder(dir);
  await again();
});

test("a lock another running process holds refuses; one a dead process left is taken over", async () => {
  const dir = await folder();
  // Another process's id: never this one's, whatever the system gave it.
  await writeFile(path.join(dir, `${LOCK_FILE}.3`), JSON.stringify({ pid: process.pid + 1, token: "theirs", since: 0 }));
  await assert.rejects(holdFolder(dir, () => true), /already running for this account/, "its process is still running");
  const release = await holdFolder(dir, () => false);
  assert.equal((JSON.parse(await readFile(path.join(dir, `${LOCK_FILE}.4`), "utf8")) as { pid: number }).pid, process.pid, "taken over, as the next generation");
  assert.ok(!existsSync(path.join(dir, `${LOCK_FILE}.3`)), "and the dead holder's tidied away");
  await release();
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(LOCK_FILE)), [], "let go: nothing left");
  // A damaged generation holds nothing either.
  await writeFile(path.join(dir, `${LOCK_FILE}.1`), "{ damag");
  const fromDamaged = await holdFolder(dir);
  await fromDamaged();
});

test("processes racing to take over a dead holder's lock: exactly one wins, and keeps it until it lets go", { timeout: 60_000 }, async () => {
  const dir = await folder();
  // A process that's gone: its lock is left behind.
  const dead = spawnSync(process.execPath, ["-e", ""]);
  await writeFile(path.join(dir, `${LOCK_FILE}.1`), JSON.stringify({ pid: dead.pid, token: "dead", since: 0 }));
  const racer = fileURLToPath(new URL("./fixtures/lock-racer.ts", import.meta.url));
  const startAt = Date.now() + 1_500;
  const runs = Array.from({ length: 6 }, () => new Promise<string>((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", racer, dir, String(startAt)], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", () => done(out.trim()));
  }));
  const outcomes = await Promise.all(runs);
  assert.deepEqual(outcomes.filter((o) => o.startsWith("won")), ["won\nkept"], `exactly one wins, and keeps it: ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.filter((o) => o === "refused").length, 5, "every other is refused");
});

test("a second agent for the same identity won't start until the first stops", async () => {
  const dir = await folder();
  const dispatch = async <T,>(fn: string): Promise<T> => (fn === "get_network_terms" ? { currency: "USD", live_payments: false } : fn === "payments_due" ? [] : null) as T;
  const agent = () => createAgent({ dispatch, credentials: memoryCredentials(), state: fileStore(path.join(dir, "state.json")), processorFor, confirm: async () => true, roundMs: 60_000 });
  const first = agent();
  await first.start();
  const second = agent();
  await assert.rejects(second.start(), /already running for this account/);
  await first.stop();
  await second.start();
  await second.stop();
});

test("every spelling of a folder is one folder: a symlink or a .. can't hold it twice", { skip: process.platform === "win32" }, async () => {
  const dir = await folder();
  const release = await holdFolder(dir);
  const alias = path.join(path.dirname(dir), `${path.basename(dir)}-alias`);
  symlinkSync(dir, alias);
  await assert.rejects(holdFolder(alias), /already running for this account/, "through a symlink");
  mkdirSync(path.join(dir, "sub"));
  await assert.rejects(holdFolder(path.join(dir, "sub", "..")), /already running for this account/, "through ..");
  await release();
});

test("a process id the system gave someone else is a dead holder's; the holder itself, still running, refuses", { timeout: 30_000 }, async () => {
  // A running process that isn't an agent: as if the system reused a dead
  // agent's id for it.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  try {
    await new Promise((started) => setTimeout(started, 300));
    const reused = await folder();
    await writeFile(path.join(reused, `${LOCK_FILE}.1`), JSON.stringify({ pid: other.pid, started: "when the dead agent started", token: "dead", since: 0 }));
    const release = await holdFolder(reused);
    assert.ok(existsSync(path.join(reused, `${LOCK_FILE}.2`)), "taken over: that id is someone else's now");
    await release();
    // The same id, started when the lock says: the holder, alive.
    const live = await folder();
    await writeFile(path.join(live, `${LOCK_FILE}.1`), JSON.stringify({ pid: other.pid, started: startOf(other.pid!), token: "live", since: 0 }));
    await assert.rejects(holdFolder(live), /already running for this account/);
  } finally {
    other.kill();
  }
});

test("a lock record that isn't a real holder's is damaged, and taken over: never left to keep the agent from starting", async () => {
  for (const record of [{ pid: 0, token: "x" }, { pid: -1, token: "x" }, { pid: 1.5, token: "x" }, { pid: "42", token: "x" }, { pid: 42, token: "" }, { pid: 42, token: 7 }, { pid: 42, token: "x", started: 5 }, { pid: 42, token: "x", started: "" }, null, [], "pid"]) {
    assert.equal(holderFrom(record), "unreadable", JSON.stringify(record));
    const dir = await folder();
    await writeFile(path.join(dir, `${LOCK_FILE}.1`), JSON.stringify(record));
    // Alive by any test, were it read as a holder: taken over all the same.
    const release = await holdFolder(dir, () => true);
    await release();
  }
  assert.deepEqual(holderFrom({ pid: 42, token: "x" }), { pid: 42, token: "x", started: null, since: 0 }, "one from before start times were kept");
});
