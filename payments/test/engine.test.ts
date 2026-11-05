// The agent's round against the test processor and a stand-in for the
// zome: it does exactly what's due, records it, never moves money twice for
// one network record -- however a round is cut short -- and declines what a
// payer shouldn't get (card testing, a first-order deal twice on one card).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, MAX_ATTEMPTS_PER_ORDER, MAX_NEW_PAYER_DECLINES, NEW_PAYER_WINDOW_MS, Refused, Retry, SAVED_CARD_MS, idempotencyKey } from "../src/engine.ts";
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
  if ("Refund" in d) return fn === "record_refund" && payload.settlement === d.Refund.settlement;
  return false;
}

const authorize = (offer: number, order: number, more: Partial<Extract<PaymentDue, { Authorize: unknown }>["Authorize"]> = {}): PaymentDue => ({
  Authorize: { offer: h(offer), order: h(order), leg: "Customer", amount: 2500, payer, token: "tok_test_4242", save: false, resumes: null, newcomer_deal: null, offered_at: Date.now() * 1000, ...more },
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

test("a burst of declines across new accounts pauses new payers for a while; a payer the store knows carries on", async () => {
  const z = zome();
  const processor = testProcessor("USD");
  let clock = 1_000_000;
  const engine = new Engine({ dispatch: z.dispatch, processor, state: memoryStore(), currency: "USD", now: () => clock });
  z.due = [authorize(5, 49, { payer: h(80) })];
  await engine.round();
  assert.equal(z.recorded("record_hold").length, 1, "a regular, known from now on");
  for (let i = 0; i < MAX_NEW_PAYER_DECLINES; i++) {
    z.due = [authorize(100 + i, 150 + i, { payer: h(120 + i), token: "tok_test_0002" })];
    await engine.round();
  }
  const seen = processor.held.size;
  z.due = [authorize(60, 90, { payer: h(200) })];
  await engine.round();
  assert.equal(z.recorded("record_declined").at(-1)?.code, "TooManyAttempts", "a new payer waits");
  assert.equal(processor.held.size, seen, "unseen by the processor");
  z.due = [authorize(61, 91, { payer: h(80) })];
  await engine.round();
  assert.equal(z.recorded("record_hold").length, 2, "the regular is held as ever");
  clock += NEW_PAYER_WINDOW_MS;
  z.due = [authorize(62, 92, { payer: h(201) })];
  await engine.round();
  assert.equal(z.recorded("record_hold").length, 3, "and once the burst has passed, new payers again");
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

test("a processor refusing an authorization for good is the payer's to hear about; a passing failure is tried again", async () => {
  const z = zome();
  let calls = 0;
  const failing = { ...testProcessor("USD"), authorize: async () => {
    calls += 1;
    if (calls === 1) throw new Retry("busy");
    throw new Refused("the key was revoked");
  } };
  const engine = new Engine({ dispatch: z.dispatch, processor: failing, state: memoryStore(), currency: "USD" });
  z.due = [authorize(10, 50)];
  await engine.round();
  assert.equal(z.recorded("record_declined").length, 0, "busy: left for the next round");
  await engine.round();
  assert.deepEqual(z.recorded("record_declined").map((d) => d.code), ["Unavailable"]);
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

test("a card its payer withdraws is deleted from the processor -- one they kept again since isn't", async () => {
  const z = zome();
  const forgotten: string[] = [];
  const processor = { ...testProcessor("USD"), forget: async (savedAs: string) => void forgotten.push(savedAs) };
  let clock = 1_000_000;
  const engine = new Engine({ dispatch: z.dispatch, processor, state: memoryStore(), currency: "USD", now: () => clock });
  z.due = [authorize(10, 50, { save: true })];
  await engine.round();
  // Withdrawn before it was kept again: deleted.
  clock += 1000;
  z.due = [{ Forget: { payer, at: (clock - 500) * 1000 } }];
  await engine.round();
  assert.equal(forgotten.length, 1, "deleted from the processor");
  z.due = [authorize(11, 51, { token: null })];
  await engine.round();
  assert.deepEqual(z.recorded("record_declined").map((d) => d.code), ["NoSavedCard"], "and never charged again");
  // Kept again after an older withdrawal: that withdrawal doesn't touch it.
  z.due = [authorize(12, 52, { save: true })];
  await engine.round();
  z.due = [{ Forget: { payer, at: (clock - 500) * 1000 } }];
  await engine.round();
  assert.equal(forgotten.length, 1, "a card kept again after it stays");
});

test("a card kept here unused for six months is deleted; one in use stays", async () => {
  const z = zome();
  const forgotten: string[] = [];
  const processor = { ...testProcessor("USD"), forget: async (savedAs: string) => void forgotten.push(savedAs) };
  let clock = 1_000_000;
  const engine = new Engine({ dispatch: z.dispatch, processor, state: memoryStore(), currency: "USD", now: () => clock });
  z.due = [authorize(10, 50, { save: true })];
  await engine.round();
  clock += SAVED_CARD_MS - 1000;
  z.due = [authorize(11, 51, { token: null })];
  await engine.round();
  assert.equal(z.recorded("record_hold").length, 2, "used just inside six months");
  clock += SAVED_CARD_MS - 1000;
  z.due = [];
  await engine.round();
  assert.equal(forgotten.length, 0, "its use kept it");
  clock += 2000;
  await engine.round();
  assert.equal(forgotten.length, 1, "six months unused: deleted");
});

test("a withdrawal outranks an offer still waiting; a card replaced isn't left at the processor", async () => {
  const z = zome();
  const forgotten: string[] = [];
  const processor = { ...testProcessor("USD"), forget: async (savedAs: string) => void forgotten.push(savedAs) };
  let clock = 1_000_000;
  const engine = new Engine({ dispatch: z.dispatch, processor, state: memoryStore(), currency: "USD", now: () => clock });
  const at = (ms: number) => ms * 1000;
  z.due = [authorize(10, 50, { save: true, offered_at: at(clock) })];
  await engine.round();
  // Offered on the kept card, then withdrawn, with the agent away: it deletes the card, and declines.
  clock += 5000;
  z.due = [authorize(11, 51, { token: null, offered_at: at(clock - 3000) }), { Forget: { payer, at: at(clock - 1000) } }];
  await engine.round();
  assert.equal(forgotten.length, 1, "the withdrawal is honoured, however late it's read");
  assert.deepEqual(z.recorded("record_declined").map((d) => d.code), ["NoSavedCard"], "and the waiting offer isn't charged");
  // Kept again, then another card kept over it.
  z.due = [authorize(12, 52, { save: true, offered_at: at(clock) })];
  await engine.round();
  z.due = [authorize(13, 53, { save: true, token: "tok_test_5555", offered_at: at(clock) })];
  await engine.round();
  assert.equal(forgotten.length, 2, "the card it replaced is deleted");
});
