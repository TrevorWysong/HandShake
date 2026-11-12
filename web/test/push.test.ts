// Waking a closed app through the network's relay: a failed checkout spends
// no wake tokens; an order never gets one about to stop working; a device
// the relay forgot registers again where it's allowed to; and a device that
// stops being woken while the relay can't be reached has the relay told
// later -- never left registered there.
import assert from "node:assert/strict";
import { test } from "node:test";

// Storage, as a browser keeps it.
const kept = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) },
});
// A browser window without the runtime's push, or a service worker.
Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
const { useNetwork } = await import("../src/store/network");
const { forgetPending, keepWakeable, stopWakingWhileClosed, withWakeTokens } = await import("../src/lib/network/push");

const RELAY = "https://push.example";
useNetwork.setState({ terms: { push_relay_url: RELAY } as never });
const DAY_MS = 24 * 60 * 60 * 1000;
const register = (tokens: string[], expiresAt = Date.now() + 30 * DAY_MS) => kept.set("handshake.push", JSON.stringify({ relay: RELAY, device: "dev1", secret: "s", tokens: tokens.map((token) => ({ token, expiresAt })) }));
const pool = () => (JSON.parse(kept.get("handshake.push") ?? "null") as { tokens: { token: string }[] } | null)?.tokens.map((held) => held.token);

/// The relay, faked: what it was asked, answered by `reply`.
function fakeRelay(reply: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  const asked: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${url.replace(RELAY, "")}`);
    const { status, body = {} } = reply(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { asked, restore: () => (globalThis.fetch = originalFetch) };
}
const settle = () => new Promise((done) => setTimeout(done, 10));
const tokens = Array.from({ length: 12 }, (_, i) => `t${i}`);

test("an order refused before it's written gives its wake tokens back; one that may have run doesn't", async () => {
  register(tokens);
  const refused = Object.assign(new Error('Guest("That store is closed.")'), { name: "Error" });
  await assert.rejects(withWakeTokens(true, async () => Promise.reject(refused), () => true));
  assert.deepEqual(pool(), tokens, "refused: both back, in order");
  await assert.rejects(withWakeTokens(true, async () => Promise.reject(new Error("ClientClosedWithPendingRequests")), () => false));
  assert.deepEqual(pool(), tokens.slice(2), "cut off mid-flight: spent, as the order may be out there");
  const placed = await withWakeTokens(false, async (wake) => wake, () => true);
  assert.deepEqual(placed, { wake_for_store: "t2", wake_for_driver: null }, "a pickup takes its store's token alone");
  assert.deepEqual(pool(), tokens.slice(3));
});

test("stopping while the relay's away: stopped here at once, and the relay told on a later start", async () => {
  register(tokens);
  const originalFetch = globalThis.fetch;
  let reachable = false;
  const deleted: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (!reachable) throw new TypeError("fetch failed");
    if (init?.method === "DELETE") deleted.push(JSON.parse(String(init.body)).device);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await stopWakingWhileClosed();
    assert.equal(kept.get("handshake.push"), undefined, "this device stops using it at once");
    assert.deepEqual(deleted, [], "the relay couldn't be told");
    reachable = true;
    await forgetPending();
    assert.deepEqual(deleted, ["dev1"], "and is, once it can be");
    await forgetPending();
    assert.deepEqual(deleted, ["dev1"], "once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a token about to stop working is never handed to an order, and a fresh batch is asked for", async () => {
  register(["old0", "old1"], Date.now() + DAY_MS);
  const relay = fakeRelay(() => ({ status: 200, body: { tokens: ["new0", "new1"], expiresAt: Date.now() + 30 * DAY_MS } }));
  try {
    const placed = await withWakeTokens(false, async (wake) => wake, () => true);
    assert.deepEqual(placed, { wake_for_store: null, wake_for_driver: null }, "none, rather than one nobody could use");
    await settle();
    assert.deepEqual(relay.asked, ["POST /devices/tokens"]);
    assert.deepEqual(pool(), ["new0", "new1"]);
  } finally {
    relay.restore();
  }
});

test("tokens kept before batches said when they expire are let go on the next start", async () => {
  kept.set("handshake.push", JSON.stringify({ relay: RELAY, device: "dev1", secret: "s", tokens: ["a", "b"] }));
  const relay = fakeRelay(() => ({ status: 200, body: { tokens: ["fresh"], expiresAt: Date.now() + 30 * DAY_MS } }));
  try {
    keepWakeable();
    await settle();
    assert.deepEqual(pool(), ["fresh"]);
  } finally {
    relay.restore();
  }
});

test("a device the relay forgot registers again, without asking -- only where the runtime already may", async () => {
  register([]);
  let relay = fakeRelay(() => ({ status: 404, body: { error: "This device isn't registered here." } }));
  try {
    keepWakeable();
    await settle();
    assert.equal(kept.get("handshake.push"), undefined, "no permission to lean on: waking stops, and the switch shows off");
  } finally {
    relay.restore();
  }
  register([]);
  (window as { __HANDSHAKE_PUSH__?: unknown }).__HANDSHAKE_PUSH__ = { register: async () => ({ channel: "apns", address: "apns-token" }) };
  relay = fakeRelay((url) => (url.endsWith("/devices/tokens") ? { status: 404 } : { status: 200, body: { device: "dev2", secret: "s2", tokens: ["again"], expiresAt: Date.now() + 30 * DAY_MS } }));
  try {
    keepWakeable();
    await settle();
    assert.deepEqual(relay.asked, ["POST /devices/tokens", "POST /devices"]);
    assert.equal(JSON.parse(kept.get("handshake.push")!).device, "dev2");
    assert.deepEqual(pool(), ["again"]);
  } finally {
    relay.restore();
    delete (window as { __HANDSHAKE_PUSH__?: unknown }).__HANDSHAKE_PUSH__;
  }
});
