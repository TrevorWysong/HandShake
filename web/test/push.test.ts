// Waking a closed app through the network's relay: a failed checkout spends
// no wake tokens, and a device that stops being woken while the relay can't
// be reached has the relay told later -- never left registered there.
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
const { forgetPending, stopWakingWhileClosed, withWakeTokens } = await import("../src/lib/network/push");

const RELAY = "https://push.example";
useNetwork.setState({ terms: { push_relay_url: RELAY } as never });
const register = (tokens: string[]) => kept.set("handshake.push", JSON.stringify({ relay: RELAY, device: "dev1", secret: "s", tokens }));
const pool = () => (JSON.parse(kept.get("handshake.push") ?? "null") as { tokens: string[] } | null)?.tokens;
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
