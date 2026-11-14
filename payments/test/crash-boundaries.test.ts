// Exactly one financial outcome, however the agent is cut short. One payment
// goes its whole way -- authorized (or challenged by the payer's bank and
// answered), held, captured in part, an award refunded -- and the agent is
// stopped dead at every boundary where it talks to the processor, the
// network or its own disk: just before the call, or just after it took
// effect with its answer lost (a processor that timed out after capturing,
// a power cut after a write). A fresh agent then starts on what reached the
// disk. Whichever boundary it was, the card is held once, captured once for
// what's due, and refunded once for the award, and the network hears of
// each exactly once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, type Dispatch } from "../src/engine.ts";
import { testProcessor } from "../src/adapters/test.ts";
import type { Processor } from "../src/processor.ts";
import { memoryStore, type State, type StateStore } from "../src/state.ts";
import type { PaymentDue } from "../src/types.ts";

const h = (n: number) => new Uint8Array(39).fill(n);
const same = (a: unknown, b: Uint8Array) => a instanceof Uint8Array && Buffer.from(a).equals(Buffer.from(b));

const HELD = 2500;
const CAPTURED = 1800;
const AWARD = 500;
const ACCOUNT = "Test:test:";
const [ORDER, OFFER, ANSWER, CHALLENGE, HOLD, SETTLEMENT, RULING] = [h(50), h(10), h(11), h(20), h(60), h(70), h(71)];

/// One order's customer payment as the network sees it, moving on as the
/// agent records each step -- and refusing a second record of any step, as
/// validation does, so a record made twice fails the test.
function network(token: string) {
  let phase: "offered" | "challenged" | "held" | "settled" | "done" = "offered";
  let reference = "";
  const writes: Record<string, number> = {};
  const authorize = (more: Partial<Extract<PaymentDue, { Authorize: unknown }>["Authorize"]>): PaymentDue => ({
    Authorize: { offer: OFFER, order: ORDER, leg: "Customer", amount: HELD, payer: h(1), token, save: false, resumes: null, resumed_offer: null, newcomer_deal: null, payer_established: true, work: null, offered_at: 0, ...more },
  });
  const due = (): PaymentDue[] => {
    switch (phase) {
      case "offered":
        return [authorize({})];
      // The payer answered their bank: a new offer, resuming the challenge.
      case "challenged":
        return [authorize({ offer: ANSWER, token: null, resumes: CHALLENGE, resumed_offer: OFFER })];
      case "held":
        return [{ Settle: { hold: HOLD, reference, held: HELD, captured: CAPTURED, claims: [] } }];
      case "settled":
        return [{ Refund: { settlement: SETTLEMENT, reference, ruling: RULING, amount: AWARD } }];
      case "done":
        return [];
    }
  };
  const record = (fn: string, payload: Record<string, unknown>): unknown => {
    const step = (from: typeof phase, offer: Uint8Array | null, to: typeof phase) => {
      if (phase !== from || (offer && !same(payload.offer, offer))) throw new Error(`${fn} refused: it isn't due`);
      writes[fn] = (writes[fn] ?? 0) + 1;
      phase = to;
    };
    switch (fn) {
      case "record_action":
        step("offered", OFFER, "challenged");
        return CHALLENGE;
      case "record_hold":
        step(phase === "challenged" ? "challenged" : "offered", phase === "challenged" ? ANSWER : OFFER, "held");
        reference = payload.reference as string;
        return HOLD;
      case "record_settlement":
        if (!same(payload.hold, HOLD)) throw new Error("a settlement of another hold");
        step("held", null, "settled");
        return SETTLEMENT;
      case "record_refund":
        if (payload.amount !== AWARD) throw new Error("a refund of another amount");
        step("settled", null, "done");
        return h(80);
      case "record_declined":
        writes[fn] = (writes[fn] ?? 0) + 1;
        throw new Error(`declined: ${String(payload.code)}`);
      default:
        throw new Error(`the stand-in doesn't know ${fn}`);
    }
  };
  const dispatch: Dispatch = async <T,>(fn: string, payload: unknown): Promise<T> => (fn === "payments_due" ? due() : record(fn, payload as Record<string, unknown>)) as T;
  return { dispatch, writes, get phase() { return phase; } };
}

/// An agent that dies at boundary `at` (counting from 0), `before` its call
/// or just `after` it took effect; once dead, nothing more it does lands.
/// `at` past the last boundary: it never dies, and only counts them.
function mortal(at: number, after: boolean) {
  let seen = 0;
  let dead = false;
  const step = async <T,>(act: () => Promise<T>): Promise<T> => {
    if (dead) throw new Error("the agent is gone");
    const here = seen++;
    if (here === at && !after) {
      dead = true;
      throw new Error("the agent stopped");
    }
    const out = await act();
    if (here === at) {
      dead = true;
      throw new Error("the agent stopped, its answer lost");
    }
    return out;
  };
  const dispatch = (inner: Dispatch): Dispatch => (fn, payload) => step(() => inner(fn, payload));
  const processor = (inner: Processor): Processor => ({
    ...inner,
    authorize: (request) => step(() => inner.authorize(request)),
    resume: (reference, key) => step(() => inner.resume(reference, key)),
    capture: (reference, amount, key) => step(() => inner.capture(reference, amount, key)),
    refund: (reference, amount, key) => step(() => inner.refund(reference, amount, key)),
    forget: (saved) => step(() => inner.forget(saved)),
  });
  const store = (disk: StateStore): StateStore => ({ load: () => disk.load(), save: (state: State) => step(() => disk.save(state)) });
  return { dispatch, processor, store, get seen() { return seen; }, get dead() { return dead; } };
}

/// Runs `agent`'s rounds until nothing's due, or it's stopped, or `limit`.
async function run(engine: Engine, done: () => boolean, stopped: () => boolean, limit: number) {
  for (let round = 0; round < limit && !done() && !stopped(); round++) await engine.round().catch(() => {});
}

/// One payment's whole way, its agent dying at boundary `at`, then a fresh
/// one starting on the same disk: what the processor and the network end with.
async function lifecycle(token: string, at: number, after: boolean) {
  const net = network(token);
  const processor = testProcessor("USD");
  const disk = memoryStore();
  const crash = mortal(at, after);
  const options = { currency: "USD", account: ACCOUNT };
  const first = new Engine({ ...options, dispatch: crash.dispatch(net.dispatch), processor: crash.processor(processor), state: crash.store(disk) });
  await run(first, () => net.phase === "done", () => crash.dead, 8);
  const restarted = new Engine({ ...options, dispatch: net.dispatch, processor, state: disk });
  await run(restarted, () => net.phase === "done", () => false, 8);
  return { net, processor, boundaries: crash.seen };
}

for (const [card, token] of [["a card", "tok_test_4242"], ["a card its bank challenges", "tok_test_3155"]] as const) {
  test(`${card}: stopped at any boundary, the payment still ends exactly once`, async () => {
    const { boundaries } = await lifecycle(token, Number.POSITIVE_INFINITY, false);
    assert.ok(boundaries > 8, `a payment's way crosses many boundaries (${boundaries})`);
    for (let at = 0; at < boundaries; at++) {
      for (const after of [false, true]) {
        const where = `stopped ${after ? "after" : "before"} boundary ${at} of ${boundaries}`;
        const { net, processor } = await lifecycle(token, at, after);
        assert.equal(net.phase, "done", `${where}: the payment went its whole way`);
        const expected: Record<string, number> = { record_hold: 1, record_settlement: 1, record_refund: 1, ...(token.endsWith("3155") ? { record_action: 1 } : {}) };
        assert.deepEqual(net.writes, expected, `${where}: the network heard of each step once`);
        assert.equal(processor.held.size, 1, `${where}: one authorization`);
        const [hold] = [...processor.held.values()];
        assert.deepEqual([hold.amount, hold.captured, hold.refunded], [HELD, CAPTURED, AWARD], `${where}: held, captured and refunded once, each for exactly what's due`);
      }
    }
  });
}
