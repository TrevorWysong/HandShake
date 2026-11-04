// The agent's commands, as the app reaches them: connecting checks the
// keys and the account against the network before anything is kept or
// published; what the app passes is checked as untrusted; disconnecting
// withdraws the profile and forgets the keys.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkKeysInput, createAgent } from "../src/agent.ts";
import { processorFor } from "../src/adapters/index.ts";
import { memoryCredentials } from "../src/credentials.ts";
import { memoryStore } from "../src/state.ts";
import { Refused } from "../src/processor.ts";

function setup(live_payments = false, answer = true) {
  const calls: { fn: string; payload: unknown }[] = [];
  const dispatch = async <T,>(fn: string, payload: unknown): Promise<T> => {
    calls.push({ fn, payload });
    if (fn === "get_network_terms") return { currency: "USD", live_payments } as T;
    if (fn === "payments_due") return [] as T;
    return null as T;
  };
  const credentials = memoryCredentials();
  const asked: unknown[] = [];
  const confirm = async (change: unknown) => (asked.push(change), answer);
  const agent = createAgent({ dispatch, credentials, state: memoryStore(), processorFor, confirm, roundMs: 60_000 });
  return { agent, calls, credentials, asked };
}

test("connecting checks the account, keeps the keys, and publishes only their public half", async () => {
  const { agent, calls, credentials } = setup();
  assert.equal(await agent.status(), null);
  const status = await agent.connect("Test", {});
  assert.deepEqual(status, { processor: "Test", account: "Test account", live: false });
  const published = calls.find((c) => c.fn === "set_payment_profile")!.payload;
  assert.deepEqual(published, { processor: "Test", public_key: "test", account: "", live: false });
  assert.equal((await credentials.load())?.processor, "Test");
  await agent.disconnect();
  assert.ok(calls.some((c) => c.fn === "clear_payment_profile"));
  assert.equal(await agent.status(), null, "and the keys are forgotten");
  agent.stop();
});

test("a live network takes no test account; nothing's kept or published when it's refused", async () => {
  const { agent, calls, credentials } = setup(true);
  await assert.rejects(agent.connect("Test", {}), /real payments/);
  await assert.rejects(agent.connect("Stripe", { publishable_key: "pk_test_abcdefghijklmnop", restricted_key: "sk_test_abcdefghijklmnop" }), /full secret key/);
  assert.equal(await credentials.load(), null);
  assert.ok(!calls.some((c) => c.fn === "set_payment_profile"));
  agent.stop();
});

test("nothing connects or disconnects without the person's own yes", async () => {
  const { agent, calls, credentials, asked } = setup(false, false);
  await assert.rejects(agent.connect("Test", {}), /didn't confirm/);
  assert.equal(asked.length, 1, "asked, with the account found");
  assert.equal(await credentials.load(), null, "and nothing kept");
  assert.ok(!calls.some((c) => c.fn === "set_payment_profile"), "nor published");
  await assert.rejects(agent.disconnect(), /didn't confirm/);
  assert.ok(!calls.some((c) => c.fn === "clear_payment_profile"));
  agent.stop();
});

test("what the app passes is checked as untrusted", () => {
  assert.throws(() => checkKeysInput("PayPal", {}), Refused);
  assert.throws(() => checkKeysInput("Stripe", "pk_test"), Refused);
  assert.throws(() => checkKeysInput("toString", {}), Refused);
  assert.throws(() => checkKeysInput("Stripe", { access_token: "a" }), Refused, "another processor's field");
  assert.throws(() => checkKeysInput("Stripe", JSON.parse('{"__proto__": "a"}')), Refused);
  assert.throws(() => checkKeysInput("Stripe", { restricted_key: "x".repeat(501) }), Refused);
  assert.throws(() => checkKeysInput("Stripe", { restricted_key: 1 }), Refused);
  assert.deepEqual(checkKeysInput("Stripe", { publishable_key: " pk_test_x " }), { processor: "Stripe", keys: { publishable_key: "pk_test_x" } });
});
