// The agent's round against the test processor and a stand-in for the
// zome: it does exactly what's due, records it, never moves money twice for
// one network record -- however a round is cut short -- and declines what a
// payer shouldn't get (card testing, a first-order deal twice on one card).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, MAX_ATTEMPTS_PER_ORDER, idempotencyKey } from "../src/engine.ts";
import { testProcessor } from "../src/adapters/test.ts";
import { memoryStore } from "../src/state.ts";
import type { PaymentDue } from "../src/types.ts";

const h = (n: number) => new Uint8Array(39).fill(n);
const payer = h(1);
const store = h(2);

/// The zome, as the agent sees it: what's due, and what the agent recorded.
function zome() {
  let due: PaymentDue[] = [];
  const calls: { fn: string; payload: Record<string, unknown> }[] = [];
  let failNext: string | null = null;
  let actions = 0;
  const dispatch = async <T,>(fn: string, payload: unknown): Promise<T> => {
    if (fn === "payments_due") return due as T;
    if (failNext === fn) {
      failNext = null;
      throw new Error("conductor went away");
    }
    calls.push({ fn, payload: payload as Record<string, unknown> });
    due = due.filter((d) => !answers(d, fn, payload as Record<string, unknown>));
    return (fn === "record_action" ? h(200 + actions++) : h(99)) as T;
  };
  return {
    dispatch,
    calls,
    set due(next: PaymentDue[]) {
      due = next;
    },
    failOnce(fn: string) {
      failNext = fn;
    },
    recorded: (fn: string) => calls.filter((c) => c.fn === fn).map((c) => c.payload),
  };
}
/// Whether recording `fn` answers `d`, so it's no longer due.
function answers(d: PaymentDue, fn: string, payload: Record<string, unknown>) {
  if ("Authorize" in d) return ["record_hold", "record_declined", "record_action"].includes(fn) && payload.offer === d.Authorize.offer;
  if ("Settle" in d) return fn === "record_settlement" && payload.hold === d.Settle.hold;
  return fn === "record_refund" && payload.settlement === d.Refund.settlement;
}

const authorize = (offer: number, order: number, more: Partial<Extract<PaymentDue, { Authorize: unknown }>["Authorize"]> = {}): PaymentDue => ({
  Authorize: { offer: h(offer), order: h(order), leg: "Customer", amount: 2500, payer, token: "tok_test_4242", save: false, resumes: null, newcomer_deal: null, ...more },
});

function setup() {
  const z = zome();
  const processor = testProcessor("USD");
  const engine = new Engine({ dispatch: z.dispatch, processor, state: memoryStore(), currency: "USD" });
  return { z, processor, engine };
}

test("an offer is held for exactly what the network says, under the processor's reference", async () => {
  const { z, processor, engine } = setup();
  z.due = [authorize(10, 50)];
  assert.equal(await engine.round(), 1);
  const [hold] = z.recorded("record_hold");
  assert.deepEqual(hold.offer, h(10));
  assert.equal(processor.held.get(hold.reference as string)?.amount, 2500);
  assert.equal(await engine.round(), 0, "and once held, nothing's left to do");
});

test("a declined card is recorded as declined, with why", async () => {
  const { z, engine } = setup();
  z.due = [authorize(10, 50, { token: "tok_test_9995" }), authorize(11, 51, { token: "tok_test_0002" })];
  await engine.round();
  assert.deepEqual(z.recorded("record_declined").map((d) => d.code), ["InsufficientFunds", "Declined"]);
});

test("a card its bank challenges asks the payer, then holds once they've answered", async () => {
  const { z, engine } = setup();
  z.due = [authorize(10, 50, { token: "tok_test_3155" })];
  await engine.round();
  const [action] = z.calls.filter((c) => c.fn === "record_action");
  assert.ok(action, "the payer is asked to confirm");
  z.due = [authorize(12, 50, { token: null, resumes: h(200) })];
  await engine.round();
  assert.equal(z.recorded("record_hold").length, 1, "held once they have");
  // An answer to a challenge the agent never made fails, rather than holding anything.
  z.due = [authorize(13, 51, { token: null, resumes: h(201) })];
  await engine.round();
  assert.deepEqual(z.recorded("record_declined").map((d) => d.code), ["ActionFailed"]);
});

test("a card is used again only if its payer saved it here", async () => {
  const { z, engine } = setup();
  z.due = [authorize(10, 50, { token: null })];
  await engine.round();
  assert.deepEqual(z.recorded("record_declined").map((d) => d.code), ["NoSavedCard"]);
  z.due = [authorize(11, 51, { save: true })];
  await engine.round();
  z.due = [authorize(12, 52, { token: null })];
  await engine.round();
  assert.equal(z.recorded("record_hold").length, 2, "saved, the next order needs no card typed");
});

test("a first-order deal takes one card once, however many accounts it comes from", async () => {
  const { z, processor, engine } = setup();
  z.due = [authorize(10, 50, { newcomer_deal: store })];
  await engine.round();
  assert.equal(z.recorded("record_hold").length, 1);
  // The same card, another account's first order here.
  z.due = [authorize(11, 51, { newcomer_deal: store, payer: h(7) })];
  await engine.round();
  assert.deepEqual(z.recorded("record_declined").map((d) => d.code), ["NotEligible"]);
  const released = [...processor.held.values()].filter((a) => a.captured === 0);
  assert.equal(released.length, 1, "its hold released at once, never charged");
  // Another card is welcome; and the first card at another store.
  z.due = [authorize(12, 52, { newcomer_deal: store, token: "tok_test_5556" }), authorize(13, 53, { newcomer_deal: h(3) })];
  await engine.round();
  assert.equal(z.recorded("record_hold").length, 3);
});

test("too many tries on an order, or by a payer in an hour, are declined before the processor sees them", async () => {
  const { z, processor, engine } = setup();
  for (let i = 0; i < MAX_ATTEMPTS_PER_ORDER; i++) {
    z.due = [authorize(10 + i, 50, { token: "tok_test_0002" })];
    await engine.round();
  }
  const before = processor.held.size;
  z.due = [authorize(30, 50)];
  await engine.round();
  assert.equal(z.recorded("record_declined").at(-1)?.code, "TooManyAttempts");
  assert.equal(processor.held.size, before, "the processor never saw it");
  // An offer tried again after a crash is the same attempt, not another.
  const { z: z2, engine: e2 } = setup();
  z2.due = [authorize(40, 60)];
  z2.failOnce("record_hold");
  await e2.round();
  await e2.round();
  assert.equal(z2.recorded("record_hold").length, 1);
});

test("a hold is charged once for what's due, the rest released -- even if recording it failed", async () => {
  const { z, processor, engine } = setup();
  z.due = [authorize(10, 50)];
  await engine.round();
  const reference = z.recorded("record_hold")[0].reference as string;
  const settle: PaymentDue = { Settle: { hold: h(60), reference, held: 2500, captured: 1800, claims: [] } };
  z.due = [settle];
  z.failOnce("record_settlement");
  await engine.round();
  assert.equal(processor.held.get(reference)?.captured, 1800, "captured");
  assert.equal(z.recorded("record_settlement").length, 0, "but not recorded");
  await engine.round();
  assert.equal(z.recorded("record_settlement").length, 1, "the next round records it, without capturing again");
  assert.equal(processor.held.get(reference)?.captured, 1800);
});

test("a hold released is never charged, and more than was held is refused", async () => {
  const { z, processor, engine } = setup();
  z.due = [authorize(10, 50), authorize(11, 51)];
  await engine.round();
  const [a, b] = z.recorded("record_hold").map((r) => r.reference as string);
  const problems: unknown[] = [];
  const watched = new Engine({ dispatch: z.dispatch, processor, state: memoryStore(), currency: "USD", onProblem: (_, err) => problems.push(err) });
  z.due = [
    { Settle: { hold: h(60), reference: a, held: 2500, captured: 0, claims: [] } },
    { Settle: { hold: h(61), reference: b, held: 2500, captured: 2600, claims: [] } },
  ];
  await watched.round();
  assert.equal(processor.held.get(a)?.captured, 0, "released");
  assert.equal(processor.held.get(b)?.captured, null, "not touched");
  assert.equal(problems.length, 1);
});

test("an award is refunded once, from what was charged", async () => {
  const { z, processor, engine } = setup();
  z.due = [authorize(10, 50)];
  await engine.round();
  const reference = z.recorded("record_hold")[0].reference as string;
  z.due = [{ Settle: { hold: h(60), reference, held: 2500, captured: 2500, claims: [] } }];
  await engine.round();
  const refund: PaymentDue = { Refund: { settlement: h(70), reference, ruling: h(71), amount: 1500 } };
  z.due = [refund];
  z.failOnce("record_refund");
  await engine.round();
  z.due = [refund];
  await engine.round();
  assert.equal(processor.held.get(reference)?.refunded, 1500, "refunded once, though recorded on the second round");
});

test("rounds never overlap", async () => {
  const { z, engine } = setup();
  z.due = [authorize(10, 50)];
  const [first, second] = await Promise.all([engine.round(), engine.round()]);
  assert.equal(first, second, "the second is the first");
  assert.equal(z.recorded("record_hold").length, 1);
});

test("idempotency keys fit every processor, and differ by what they're for", () => {
  const key = idempotencyKey("capture", h(1), 100);
  assert.equal(key.length, 40);
  assert.notEqual(key, idempotencyKey("capture", h(1), 101));
  assert.notEqual(key, idempotencyKey("refund", h(1), 100));
});
