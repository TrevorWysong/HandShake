// The payment agent's round: read what the network says this payee should
// do (`payments_due`), do it on their processor, and record what happened.
// Amounts only ever come from the network -- the agent has no say in them,
// and nothing outside it can name one. Every processor call carries an
// idempotency key made from the network record it answers, so a round cut
// short by a crash, and done again, moves money once. Rounds never overlap.
import { createHash } from "node:crypto";
import type { Authorization, Processor } from "./processor.ts";
import { Refused, Retry } from "./processor.ts";
import type { State, StateStore } from "./state.ts";
import type { ActionHash, DeclineCode, PaymentDue } from "./types.ts";

/// A call to the payee's own dispatch zome.
export type Dispatch = <T>(fn: string, payload: unknown) => Promise<T>;

/// The most authorizations one order's payer can try here, and one payer
/// in an hour, before the agent declines: no card testing through the
/// payee's account.
export const MAX_ATTEMPTS_PER_ORDER = 5;
export const MAX_ATTEMPTS_PER_PAYER_HOUR = 10;
const HOUR_MS = 3_600_000;
/// Attempts older than an authorization can live are forgotten.
const ATTEMPTS_KEPT_MS = 8 * 24 * HOUR_MS;

export interface EngineOptions {
  dispatch: Dispatch;
  processor: Processor;
  state: StateStore;
  /// The network's currency (`NetworkTerms.currency`).
  currency: string;
  now?: () => number;
  /// What went wrong with one payment, for the payee's log.
  onProblem?: (what: string, err: unknown) => void;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/// A processor's idempotency key for `what` done to the network record
/// `about` -- 40 characters, within every processor's limit.
export function idempotencyKey(what: string, about: Uint8Array, ...more: (string | number)[]): string {
  return createHash("sha256").update(`handshake:${what}:`).update(about).update(more.join(":")).digest("hex").slice(0, 40);
}

/// An authorization's outcome -- what the payee's processor refused, for
/// good, is the payer's to hear about as unavailable, rather than an offer
/// left unanswered; what may pass on its own is tried again next round.
async function authorizing(attempt: () => Promise<Authorization>): Promise<Authorization> {
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof Refused) return { status: "declined", code: "Unavailable" };
    throw err;
  }
}

/// What the processor sees of an order: a tag that names nothing.
export const orderTag = (order: ActionHash) => `hs_${createHash("sha256").update("handshake:order:").update(order).digest("hex").slice(0, 16)}`;

export class Engine {
  #running: Promise<number> | null = null;
  readonly #o: Required<EngineOptions>;

  constructor(options: EngineOptions) {
    this.#o = { now: Date.now, onProblem: () => {}, ...options };
  }

  /// One round; a round asked for while one runs is that round. Returns
  /// how many payments it carried out.
  round(): Promise<number> {
    this.#running ??= this.#round().finally(() => (this.#running = null));
    return this.#running;
  }

  async #round(): Promise<number> {
    const { dispatch, state: store, onProblem } = this.#o;
    const due = await dispatch<PaymentDue[]>("payments_due", null);
    let done = 0;
    for (const item of due) {
      // Each payment on its own: one failing never holds up the rest.
      const state = await store.load();
      try {
        if ("Authorize" in item) await this.#authorize(item.Authorize, state);
        else if ("Settle" in item) await this.#settle(item.Settle);
        else await this.#refund(item.Refund);
        done += 1;
      } catch (err) {
        onProblem(Object.keys(item)[0], err);
      } finally {
        await store.save(state);
      }
    }
    return done;
  }

  async #authorize(due: Extract<PaymentDue, { Authorize: unknown }>["Authorize"], state: State) {
    const { dispatch, processor, currency, now } = this.#o;
    const decline = (code: DeclineCode) => dispatch("record_declined", { offer: due.offer, code });
    const payer = hex(due.payer);
    const order = hex(due.order);
    const offerKey = idempotencyKey("authorize", due.offer);

    let result: Authorization;
    if (due.resumes) {
      const reference = state.challenged[hex(due.resumes)];
      if (!reference) return decline("ActionFailed");
      result = await authorizing(() => processor.resume(reference, offerKey));
    } else {
      // Attempts, counted before the processor sees any: a retry of the
      // same offer is the same attempt.
      const offer = hex(due.offer);
      if (!state.attempts[offer]) {
        const tried = Object.entries(state.attempts).filter(([, a]) => now() - a.at < ATTEMPTS_KEPT_MS);
        state.attempts = Object.fromEntries(tried);
        const forOrder = tried.filter(([, a]) => a.order === order).length;
        const lastHour = tried.filter(([, a]) => a.payer === payer && now() - a.at < HOUR_MS).length;
        if (forOrder >= MAX_ATTEMPTS_PER_ORDER || lastHour >= MAX_ATTEMPTS_PER_PAYER_HOUR) return decline("TooManyAttempts");
        state.attempts[offer] = { payer, order, at: now() };
      }
      const savedAs = due.token === null ? (state.saved[payer] ?? null) : null;
      if (due.token === null && !savedAs) return decline("NoSavedCard");
      result = await authorizing(() => processor.authorize({ amount: due.amount, currency, token: due.token, savedAs, save: due.save, tag: orderTag(due.order), idempotencyKey: offerKey }));
    }

    if (result.status === "declined") return decline(result.code);
    if (result.status === "action") {
      const action = await dispatch<ActionHash>("record_action", { offer: due.offer, action: result.action });
      state.challenged[hex(action)] = result.reference;
      return;
    }
    // A first-order deal is one per card here: a card that took it on
    // another order is released, and the offer declined.
    if (due.newcomer_deal) {
      const store = hex(due.newcomer_deal);
      if (!result.fingerprint) {
        await processor.capture(result.reference, 0, idempotencyKey("release", due.offer));
        return decline("NotEligible");
      }
      const took = (state.newcomers[store] ??= {})[result.fingerprint];
      if (took && took !== order) {
        await processor.capture(result.reference, 0, idempotencyKey("release", due.offer));
        return decline("NotEligible");
      }
      state.newcomers[store][result.fingerprint] = order;
    }
    if (result.savedAs) state.saved[payer] = result.savedAs;
    await dispatch("record_hold", { offer: due.offer, reference: result.reference });
  }

  async #settle(due: Extract<PaymentDue, { Settle: unknown }>["Settle"]) {
    const { dispatch, processor } = this.#o;
    if (due.captured > due.held) throw new Refused("the network asks for more than was held");
    await processor.capture(due.reference, due.captured, idempotencyKey("capture", due.hold, due.captured));
    await dispatch("record_settlement", { hold: due.hold, claims: due.claims });
  }

  async #refund(due: Extract<PaymentDue, { Refund: unknown }>["Refund"]) {
    const { dispatch, processor } = this.#o;
    await processor.refund(due.reference, due.amount, idempotencyKey("refund", due.settlement, hex(due.ruling), due.amount));
    await dispatch("record_refund", { settlement: due.settlement, ruling: due.ruling, amount: due.amount });
  }
}

export { Refused, Retry };
