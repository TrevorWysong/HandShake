// The agent's commands, as the app reaches them: connecting checks the
// keys and the account against the network before anything is kept or
// published; what the app passes is checked as untrusted; disconnecting
// withdraws the profile and forgets the keys.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkKeysInput, createAgent } from "../src/agent.ts";
import { processorFor } from "../src/adapters/index.ts";
import { memoryCredentials } from "../src/credentials.ts";
import { emptyState, memoryStore } from "../src/state.ts";
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

/// Two processor accounts, told apart by their public keys, and an agent
/// whose zome answers with `due` -- for the tests of changing accounts.
function twoAccounts(state = memoryStore()) {
  const h = (n: number) => new Uint8Array(39).fill(n);
  const world = { due: [] as unknown[], recorded: [] as { fn: string; payload: Record<string, unknown> }[], holdRecording: null as Promise<void> | null, gate: null as Promise<void> | null, captured: [] as string[] };
  const dispatch = async <T,>(fn: string, payload: unknown): Promise<T> => {
    if (fn === "get_network_terms") return { currency: "USD", live_payments: false } as T;
    if (fn === "payments_due") return world.due as T;
    if (fn === "record_settlement" && world.gate) await world.gate;
    if (fn === "record_hold" && world.holdRecording) await world.holdRecording;
    world.recorded.push({ fn, payload: payload as Record<string, unknown> });
    if (["record_hold", "record_settlement", "record_declined"].includes(fn)) world.due = [];
    return null as T;
  };
  const accounts = new Map([["Stripe", testProcessor("USD")], ["Square", testProcessor("USD")]]);
  const processorFor = (name: string) => {
    const processor = accounts.get(name)!;
    return {
      ...processor,
      connect: async () => ({ ...(await processor.connect()), publicKey: `pk_${name}` }),
      capture: (reference: string, amount: number, key: string) => (world.captured.push(`${name}:${reference}`), processor.capture(reference, amount, key)),
    };
  };
  const keys = { Stripe: { publishable_key: "pk", restricted_key: "rk" }, Square: { application_id: "a", location_id: "l", access_token: "t" } };
  const agent = createAgent({ dispatch, credentials: memoryCredentials(), state, processorFor, confirm: async () => true, roundMs: 60_000 });
  const authorize = (offer: number, token: string | null, save = false) => ({ Authorize: { offer: h(offer), order: h(offer + 50), leg: "Customer", amount: 2500, payer: h(1), token, save, resumes: null, newcomer_deal: null, offered_at: Date.now() * 1000 } });
  const settle = (reference: string) => ({ Settle: { hold: h(60), reference, held: 2500, captured: 2500, claims: [] } });
  // A round of its own, after any a change started.
  const round = async () => {
    await agent.round();
    await agent.round();
  };
  const connect = async (name: "Stripe" | "Square") => {
    await agent.connect(name, keys[name]);
    agent.stop();
  };
  return { world, accounts, agent, state, authorize, settle, round, connect };
}

test("a change of account waits for the round under way, which never saves over it", async () => {
  const { world, agent, state, authorize, settle, round, connect } = twoAccounts();
  await connect("Stripe");
  world.due = [authorize(10, "tok_test_4242", true)];
  await round();
  assert.ok(Object.keys((await state.load()).saved).length > 0, "a card kept with the first account");
  const reference = world.recorded.find((r) => r.fn === "record_hold")!.payload.reference as string;

  // A round held open mid-settlement, under the first account...
  let release!: () => void;
  world.gate = new Promise((done) => (release = done));
  world.due = [settle(reference)];
  const settling = agent.round();
  await new Promise((done) => setTimeout(done, 10));
  // ...while the person moves to the second.
  let switched = false;
  const switching = agent.connect("Square", { application_id: "a", location_id: "l", access_token: "t" }).then(() => (switched = true));
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(switched, false, "the change waits for the round");
  release();
  await Promise.all([settling, switching]);
  agent.stop();
  const after = await state.load();
  assert.equal(after.account, "Square:pk_Square:");
  assert.deepEqual(after.saved, {}, "the round's last save didn't bring the first account's cards back");
});

test("disconnecting mid-round waits for it, and nothing runs with the old keys after", async () => {
  const { world, accounts, agent, authorize, settle, round, connect } = twoAccounts();
  await connect("Stripe");
  world.due = [authorize(10, "tok_test_4242")];
  await round();
  const reference = world.recorded.find((r) => r.fn === "record_hold")!.payload.reference as string;
  let release!: () => void;
  world.gate = new Promise((done) => (release = done));
  world.due = [settle(reference)];
  const settling = agent.round();
  await new Promise((done) => setTimeout(done, 10));
  const leaving = agent.disconnect();
  release();
  await Promise.all([settling, leaving]);
  world.gate = null;
  const captured = accounts.get("Stripe")!.held.get(reference)?.captured;
  world.due = [settle("anything")];
  await round();
  assert.equal(await agent.status(), null);
  assert.equal(accounts.get("Stripe")!.held.get(reference)?.captured, captured, "no round after disconnecting touched the processor");
});

test("a hold is bound to its account before the network hears of it -- a crash between them loses nothing", async () => {
  const { world, accounts, agent, state, authorize, round, connect } = twoAccounts();
  await connect("Stripe");
  await round();
  // The device stops while the network's being told of the hold: what's on
  // disk then is all a restarted agent has.
  world.holdRecording = new Promise(() => {});
  world.due = [authorize(10, "tok_test_4242")];
  void agent.round();
  await new Promise((done) => setTimeout(done, 20));
  const [reference] = [...accounts.get("Stripe")!.held.keys()];
  assert.ok(reference, "held at the processor");
  assert.equal((await state.load()).heldWith[reference], "Stripe:pk_Stripe:", "bound on disk before the network heard");
});

test("holds from before accounts were told apart belong to the account running when the agent was upgraded", async () => {
  // State as an agent from before kept it: a saved card, a hold it never bound.
  const old = memoryStore({ ...emptyState(), saved: { ["01".repeat(39)]: "cus_test_4242" }, savedAt: { ["01".repeat(39)]: Date.now() } });
  const { world, agent, settle, round, connect } = twoAccounts(old);
  await connect("Stripe");
  const before = await old.load();
  assert.equal(before.legacy, "Stripe:pk_Stripe:");
  assert.equal(Object.keys(before.saved).length, 1, "its saved cards were this account's, and stay");
  // Held earlier on Stripe, unbound: the test processor takes it as held.
  const legacyHold = "test_auth_legacy";
  await connect("Square");
  world.due = [settle(legacyHold)];
  await round();
  assert.deepEqual(world.captured, [], "never sent to the other account");
  await connect("Stripe");
  world.due = [settle(legacyHold)];
  await round();
  assert.deepEqual(world.captured, [`Stripe:${legacyHold}`], "settled back on its own account");
  assert.equal((await agent.status())?.trouble, null);
});

test("keys a processor refuses while connecting are called mistyped, not revoked, and nothing is kept", async () => {
  const { KeyRefused } = await import("../src/processor.ts");
  const dispatch = async <T,>(fn: string): Promise<T> => (fn === "get_network_terms" ? ({ currency: "USD", live_payments: false } as T) : (null as T));
  const credentials = memoryCredentials();
  const refusing = () => ({ ...testProcessor("USD"), connect: async () => { throw new KeyRefused("Stripe no longer accepts this device's key. Connect again."); } });
  const agent = createAgent({ dispatch, credentials, state: memoryStore(), processorFor: refusing, confirm: async () => true, roundMs: 60_000 });
  await assert.rejects(agent.connect("Stripe", { publishable_key: "pk", restricted_key: "rk" }), /Those keys weren't accepted by Stripe\. Check them in its dashboard/);
  assert.equal(await credentials.load(), null);
});

test("holds from the version that knew accounts but didn't bind holds stay with the account it ran", async () => {
  // As cb6c4ec kept it: an account, no `legacy`, and a hold it never bound.
  const { legacy: _, ...shape } = { ...emptyState(), account: "Stripe:pk_Stripe:" };
  const { world, settle, round, connect } = twoAccounts(memoryStore(shape as ReturnType<typeof emptyState>));
  await connect("Square");
  world.due = [settle("test_auth_unbound")];
  await round();
  assert.deepEqual(world.captured, [], "never sent to the account connected after the upgrade");
  await connect("Stripe");
  world.due = [settle("test_auth_unbound")];
  await round();
  assert.deepEqual(world.captured, ["Stripe:test_auth_unbound"]);
});

/// An agent on `credentials`, whose zome calls are logged -- and can be
/// made to fail, as a crash would cut them short.
function restartable(credentials = memoryCredentials()) {
  const calls: string[] = [];
  const failing = new Set<string>();
  const dispatch = async <T,>(fn: string): Promise<T> => {
    if (failing.has(fn)) throw new Error("the device stopped");
    calls.push(fn);
    if (fn === "get_network_terms") return { currency: "USD", live_payments: false } as T;
    if (fn === "payments_due") return [] as T;
    return null as T;
  };
  const agent = createAgent({ dispatch, credentials, state: memoryStore(), processorFor, confirm: async () => true, roundMs: 60_000 });
  return { agent, calls, failing, credentials };
}

test("a start puts the network's profile right by the keys this device keeps", async () => {
  // Connecting cut short after the profile was published, before the keys were kept.
  const first = restartable();
  first.credentials.save = async () => {
    throw new Error("the device stopped");
  };
  await assert.rejects(first.agent.connect("Test", {}));
  first.agent.stop();
  assert.ok(first.calls.includes("set_payment_profile"), "published");
  const restarted = restartable(memoryCredentials());
  await restarted.agent.start();
  restarted.agent.stop();
  assert.ok(restarted.calls.includes("clear_payment_profile"), "no keys kept: the profile is withdrawn");

  // Keys kept: the start publishes their profile, whatever the network had.
  const kept = restartable();
  await kept.agent.connect("Test", {});
  kept.agent.stop();
  const again = restartable(kept.credentials);
  await again.agent.start();
  again.agent.stop();
  assert.ok(again.calls.includes("set_payment_profile"));
  assert.ok(!again.calls.includes("clear_payment_profile"));
});

test("disconnecting forgets the keys first: cut short, the next start withdraws the profile and doesn't run", async () => {
  const { agent, failing, credentials } = restartable();
  await agent.connect("Test", {});
  failing.add("clear_payment_profile");
  await assert.rejects(agent.disconnect());
  agent.stop();
  assert.equal(await credentials.load(), null, "the keys went first");
  const restarted = restartable(credentials);
  await restarted.agent.start();
  restarted.agent.stop();
  assert.ok(restarted.calls.includes("clear_payment_profile"));
  assert.equal(await restarted.agent.status(), null);
  assert.ok(!restarted.calls.includes("payments_due"), "nothing runs with keys it no longer has");
});

test("a start that can't put the profile right pays nothing, and starts once it can", async (t) => {
  // Keys kept from an earlier run.
  const earlier = restartable();
  await earlier.agent.connect("Test", {});
  earlier.agent.stop();

  const calls: string[] = [];
  let networkDown = true;
  const dispatch = async <T,>(fn: string): Promise<T> => {
    if (networkDown && fn === "set_payment_profile") throw new Error("the network isn't reachable");
    calls.push(fn);
    if (fn === "get_network_terms") return { currency: "USD", live_payments: false } as T;
    if (fn === "payments_due") return [] as T;
    return null as T;
  };
  const problems: string[] = [];
  const agent = createAgent({ dispatch, credentials: earlier.credentials, state: memoryStore(), processorFor, confirm: async () => true, roundMs: 20, onProblem: (what) => problems.push(what) });
  t.after(() => agent.stop());
  await agent.start();
  agent.wake();
  assert.equal(await agent.round(), 0, "no engine: a round asked for does nothing");
  await new Promise((done) => setTimeout(done, 70));
  assert.ok(problems.length > 0, "the failure is reported");
  assert.ok(!calls.includes("payments_due"), "nothing asked of payments while it can't be reconciled");

  // The network's back: a later tick reconciles, and rounds begin.
  networkDown = false;
  await new Promise((done) => setTimeout(done, 70));
  assert.ok(calls.includes("set_payment_profile"));
  assert.ok(calls.indexOf("set_payment_profile") < calls.indexOf("payments_due"), "reconciled before any round");
});

test("a connect cut short while running puts the network back to the keys kept, and carries on with them", async (t) => {
  const published: string[] = [];
  const asked: string[] = [];
  const dispatch = async <T,>(fn: string, payload: unknown): Promise<T> => {
    if (fn === "set_payment_profile") published.push((payload as { public_key: string }).public_key);
    if (fn === "payments_due") asked.push(fn);
    if (fn === "get_network_terms") return { currency: "USD", live_payments: false } as T;
    if (fn === "payments_due") return [] as T;
    return null as T;
  };
  const kept = memoryCredentials();
  let failSave = false;
  const credentials = { ...kept, save: async (c: Parameters<typeof kept.save>[0]) => (failSave ? Promise.reject(new Error("the disk is full")) : kept.save(c)) };
  const publicKeyOf = (name: string) => async () => ({ ...(await testProcessor("USD").connect()), publicKey: `pk_${name}` });
  const processorFor = (name: string) => ({ ...testProcessor("USD"), connect: publicKeyOf(name) });
  const agent = createAgent({ dispatch, credentials, state: memoryStore(), processorFor, confirm: async () => true, roundMs: 20 });
  t.after(() => agent.stop());
  await agent.start();
  await agent.connect("Stripe", { publishable_key: "pk", restricted_key: "rk" });

  failSave = true;
  await assert.rejects(agent.connect("Square", { application_id: "a", location_id: "l", access_token: "t" }), /disk is full/);
  failSave = false;
  await new Promise((done) => setTimeout(done, 60));
  const square = published.lastIndexOf("pk_Square");
  assert.ok(square >= 0, "the new profile went out before the save failed");
  assert.ok(published.lastIndexOf("pk_Stripe") > square, "and was put back to the keys still kept");
  assert.equal((await agent.status())?.processor, "Stripe");
  const before = asked.length;
  await new Promise((done) => setTimeout(done, 60));
  assert.ok(asked.length > before, "rounds carry on with them");
});
