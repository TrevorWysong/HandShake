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
import { testProcessor } from "../src/adapters/test.ts";

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
  assert.deepEqual(status, { processor: "Test", account: "Test account", live: false, trouble: null });
  const published = calls.find((c) => c.fn === "set_payment_profile")!.payload;
  assert.deepEqual(published, { processor: "Test", public_key: "test", account: "", live: false, country: "" });
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
  assert.throws(() => checkKeysInput("Venmo", {}), Refused);
  assert.throws(() => checkKeysInput("Stripe", "pk_test"), Refused);
  assert.throws(() => checkKeysInput("toString", {}), Refused);
  assert.throws(() => checkKeysInput("Stripe", { access_token: "a" }), Refused, "another processor's field");
  assert.throws(() => checkKeysInput("Stripe", JSON.parse('{"__proto__": "a"}')), Refused);
  assert.throws(() => checkKeysInput("Stripe", { restricted_key: "x".repeat(501) }), Refused);
  assert.throws(() => checkKeysInput("Stripe", { restricted_key: 1 }), Refused);
  assert.deepEqual(checkKeysInput("Stripe", { publishable_key: " pk_test_x " }), { processor: "Stripe", keys: { publishable_key: "pk_test_x" } });
});

test("a payment the agent couldn't carry out shows in its status -- what kind, never the processor's words -- until a round goes cleanly", async () => {
  let failing = true;
  const dispatch = async <T,>(fn: string): Promise<T> => {
    if (fn === "get_network_terms") return { currency: "USD", live_payments: false } as T;
    if (fn === "payments_due") return (failing ? [{ Settle: { hold: new Uint8Array(39), reference: "nowhere", held: 100, captured: 100, claims: [] } }] : []) as T;
    if (fn === "record_settlement") throw new Error("internal detail the app mustn't see");
    return null as T;
  };
  const agent = createAgent({ dispatch, credentials: memoryCredentials(), state: memoryStore(), processorFor, confirm: async () => true, roundMs: 60_000 });
  await agent.connect("Test", {});
  await agent.round();
  const troubled = await agent.status();
  assert.equal(troubled?.trouble?.what, "Settle");
  assert.deepEqual(Object.keys(troubled!.trouble!).sort(), ["at", "what"], "nothing of the processor's error");
  failing = false;
  await agent.round();
  assert.equal((await agent.status())?.trouble, null, "cleared by a clean round");
  agent.stop();
});

test("a wake asked for mid-round shares that round's verdict -- it never clears trouble the round found", async () => {
  const dispatch = async <T,>(fn: string): Promise<T> => {
    if (fn === "get_network_terms") return { currency: "USD", live_payments: false } as T;
    if (fn === "payments_due") return [{ Settle: { hold: new Uint8Array(39), reference: "r", held: 100, captured: 100, claims: [] } }] as T;
    if (fn === "record_settlement") throw new Error("refused");
    return null as T;
  };
  // The round held open after its trouble, at its last save.
  let finish!: () => void;
  const finished = new Promise<void>((done) => (finish = done));
  let holding = false;
  const memory = memoryStore();
  const state = { load: () => memory.load(), save: async (next: Parameters<typeof memory.save>[0]) => {
    if (holding) await finished;
    return memory.save(next);
  } };
  let troubled = () => {};
  const agent = createAgent({ dispatch, credentials: memoryCredentials(), state, processorFor, confirm: async () => true, roundMs: 60_000, onProblem: () => troubled() });
  await agent.connect("Test", {});
  agent.stop();
  await agent.round();
  holding = true;
  const found = new Promise<void>((done) => (troubled = done));
  const first = agent.round();
  await found;
  const second = agent.round();
  finish();
  await Promise.all([first, second]);
  assert.equal((await agent.status())?.trouble?.what, "Settle");
});

test("switching processor accounts never sends one account's payments to another; they settle when it's back", async () => {
  const h = (n: number) => new Uint8Array(39).fill(n);
  let due: unknown[] = [];
  const recorded: { fn: string; payload: Record<string, unknown> }[] = [];
  const dispatch = async <T,>(fn: string, payload: unknown): Promise<T> => {
    if (fn === "get_network_terms") return { currency: "USD", live_payments: false } as T;
    if (fn === "payments_due") return due as T;
    recorded.push({ fn, payload: payload as Record<string, unknown> });
    if (fn === "record_hold" || fn === "record_settlement" || fn === "record_declined") due = [];
    return null as T;
  };
  // Two accounts, told apart by their public keys.
  const accounts = new Map([["Stripe", testProcessor("USD")], ["Square", testProcessor("USD")]]);
  const forAccount = (name: string) => {
    const processor = accounts.get(name)!;
    return { ...processor, connect: async () => ({ ...(await processor.connect()), publicKey: `pk_${name}` }) };
  };
  const keys = { Stripe: { publishable_key: "pk", restricted_key: "rk" }, Square: { application_id: "a", location_id: "l", access_token: "t" } };
  const agent = createAgent({ dispatch, credentials: memoryCredentials(), state: memoryStore(), processorFor: (name) => forAccount(name), confirm: async () => true, roundMs: 60_000 });
  // A round of its own, after any connecting started.
  const round = async () => {
    await agent.round();
    await agent.round();
  };
  const authorize = (offer: number, token: string | null, save = false) => ({ Authorize: { offer: h(offer), order: h(offer + 50), leg: "Customer", amount: 2500, payer: h(1), token, save, resumes: null, newcomer_deal: null, offered_at: Date.now() * 1000 } });

  await agent.connect("Stripe", keys.Stripe);
  agent.stop();
  due = [authorize(10, "tok_test_4242", true)];
  await round();
  const reference = recorded.find((r) => r.fn === "record_hold")!.payload.reference as string;

  // Moved to another account: the first's hold isn't sent there.
  await agent.connect("Square", keys.Square);
  agent.stop();
  due = [{ Settle: { hold: h(60), reference, held: 2500, captured: 2500, claims: [] } }];
  await round();
  assert.equal(accounts.get("Square")!.held.size, 0);
  assert.equal(accounts.get("Stripe")!.held.get(reference)?.captured, null);
  assert.equal((await agent.status())?.trouble?.what, "Settle");
  // And a card saved with the first can't be charged with the second.
  due = [authorize(11, null)];
  await round();
  assert.deepEqual(recorded.filter((r) => r.fn === "record_declined").map((r) => r.payload.code), ["NoSavedCard"]);

  // Back on the first account, its hold settles there.
  await agent.connect("Stripe", keys.Stripe);
  agent.stop();
  due = [{ Settle: { hold: h(60), reference, held: 2500, captured: 2500, claims: [] } }];
  await round();
  assert.equal(accounts.get("Stripe")!.held.get(reference)?.captured, 2500);
  assert.equal((await agent.status())?.trouble, null);
});
