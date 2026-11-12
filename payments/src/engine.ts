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
/// New accounts are free, so the per-payer caps don't stop cards being
/// tested across many of them. Only payers with no history count: one
/// whose card held here before, or who has a record on the network
/// (`payer_established`), carries on as ever. This many declines of the
/// others' cards within the window is a burst. During one, the agent asks
/// payers with no history for proof of work (`record_busy`; their app does
/// it as it sends the card), doubling it each time the declines double. A
/// real newcomer spends a moment of their device's time and is never
/// turned away for someone else's attack; testing cards costs that work
/// again for every account, and more the longer it goes on.
export const MAX_NEW_PAYER_DECLINES = 10;
export const NEW_PAYER_WINDOW_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
/// Attempts older than an authorization can live are forgotten.
const ATTEMPTS_KEPT_MS = 8 * 24 * HOUR_MS;
/// A card kept here and unused this long is deleted -- the network refuses
/// it by then too (`dispatch_integrity::payments::SAVED_CARD_DAYS`).
export const SAVED_CARD_MS = 180 * 24 * HOUR_MS;

export interface EngineOptions {
  dispatch: Dispatch;
  processor: Processor;
  state: StateStore;
  /// The network's currency (`NetworkTerms.currency`).
  currency: string;
  /// The processor account connected now (`accountId`).
  account: string;
  now?: () => number;
  /// What went wrong with one payment, for the payee's log.
  onProblem?: (what: string, err: unknown) => void;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));

/// A write that met another on the payee's chain -- their app writing at
/// the same moment -- wrote nothing, so it's tried again at once rather than
/// a round later: a driver waiting on a hold to commit has under a minute.
const COLLIDED = /source chain head has moved/i;
const COLLISION_RETRIES = 4;
const COLLISION_PAUSE_MS = 250;

/// `dispatch`, trying a call again when it only collided with another write.
export function retryingCollisions(dispatch: Dispatch, pause = (ms: number) => new Promise((done) => setTimeout(done, ms))): Dispatch {
  return async <T>(fn: string, payload: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await dispatch<T>(fn, payload);
      } catch (err) {
        if (attempt >= COLLISION_RETRIES || !COLLIDED.test(err instanceof Error ? err.message : String(err))) throw err;
        await pause(COLLISION_PAUSE_MS * (attempt + 1));
      }
    }
  };
}

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
    this.#o = { now: Date.now, onProblem: () => {}, ...options, dispatch: retryingCollisions(options.dispatch) };
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
    // Upkeep never stands in the way of what's owed: a part that fails is
    // reported, kept for the next round, and the payments go on.
    await this.#claimKeptCards().catch((err) => onProblem("Claim kept cards", err));
    let done = await this.#expireSavedCards().catch((err) => (onProblem("Expire saved cards", err), 0));
    // Withdrawals first: a card withdrawn is charged by no offer still waiting.
    for (const item of [...due].sort((a, b) => Number("Forget" in b) - Number("Forget" in a))) {
      // Each payment on its own: one failing never holds up the rest.
      const state = await store.load();
      try {
        // Nothing to do on it yet -- but never taken for "nothing due".
        if ("Unreadable" in item) throw new Error(`what's due on an order couldn't be read: ${item.Unreadable.reason}`);
        if ("Authorize" in item) await this.#authorize(item.Authorize, state);
        else if ("Settle" in item) await this.#settle(item.Settle, state);
        else if ("Refund" in item) await this.#refund(item.Refund, state);
        // A withdrawal stays listed for as long as its card could stand:
        // done only when there was a card to delete.
        else if (!(await this.#forget(item.Forget, state))) continue;
        done += 1;
      } catch (err) {
        onProblem(Object.keys(item)[0], err);
      } finally {
        await store.save(state);
      }
    }
    return done;
  }

  /// First-order cards an agent from before kept on this device alone,
  /// claimed on the network -- each on its own, then forgotten here. One
  /// that can't be claimed just now is reported and kept, and still counts
  /// here meanwhile (`#authorize`), so no card slips through in between.
  async #claimKeptCards() {
    const { dispatch, state: store, onProblem } = this.#o;
    const state = await store.load();
    if (Object.keys(state.newcomers).length === 0) return;
    for (const [shop, cards] of Object.entries(state.newcomers)) {
      for (const [fingerprint, order] of Object.entries(cards)) {
        try {
          await dispatch<boolean>("claim_newcomer_card", { store: unhex(shop), fingerprint, order: unhex(order) });
          delete cards[fingerprint];
        } catch (err) {
          onProblem("Claim kept card", err);
        }
      }
      if (Object.keys(cards).length === 0) delete state.newcomers[shop];
      await store.save(state);
    }
  }

  /// The busy record payers with no history do work for now: the one in
  /// force, if it asks as much as `level` -- or a new one, kept for the
  /// window.
  async #busy(state: State, level: number): Promise<NonNullable<State["busy"]>> {
    const { dispatch, now } = this.#o;
    if (state.busy && state.busy.until > now() && state.busy.level >= level) return state.busy;
    const until = now() + NEW_PAYER_WINDOW_MS;
    const asked = await dispatch<{ busy: ActionHash; bits: number }>("record_busy", { level, until: until * 1000 });
    state.busy = { record: hex(asked.busy), bits: asked.bits, level, until };
    return state.busy;
  }

  async #authorize(due: Extract<PaymentDue, { Authorize: unknown }>["Authorize"], state: State) {
    const { dispatch, processor, currency, now } = this.#o;
    const decline = async (code: DeclineCode) => {
      await dispatch("record_declined", { offer: due.offer, code });
    };
    const payer = hex(due.payer);
    const order = hex(due.order);
    const established = state.known[payer] === true || due.payer_established;
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
      state.declines = state.declines.filter((at) => now() - at < NEW_PAYER_WINDOW_MS);
      if (!established && state.declines.length >= MAX_NEW_PAYER_DECLINES) {
        const busy = await this.#busy(state, Math.floor(Math.log2(state.declines.length / MAX_NEW_PAYER_DECLINES)));
        const proved = due.work !== null && hex(due.work.busy) === busy.record && due.work.bits >= busy.bits;
        if (!proved) return decline("WorkNeeded");
      }
      const savedAs = due.token === null ? (state.saved[payer] ?? null) : null;
      if (due.token === null && !savedAs) return decline("NoSavedCard");
      result = await authorizing(() => processor.authorize({ amount: due.amount, currency, token: due.token, savedAs, save: due.save, tag: orderTag(due.order), idempotencyKey: offerKey }));
    }

    if (result.status === "declined") {
      if (!established && result.code !== "Unavailable") state.declines.push(now());
      return decline(result.code);
    }
    if (result.status === "action") {
      const action = await dispatch<ActionHash>("record_action", { offer: due.offer, action: result.action });
      state.challenged[hex(action)] = result.reference;
      return;
    }
    // A first-order deal is one per card here: a card that took it on
    // another order is released, and the offer declined. Kept on the
    // network, so a store's new or reset device remembers it.
    if (due.newcomer_deal) {
      // One kept here and not yet claimed on the network counts too.
      const keptHere = result.fingerprint === null ? undefined : state.newcomers[hex(due.newcomer_deal)]?.[result.fingerprint];
      const claimed = result.fingerprint !== null && (keptHere === undefined || keptHere === order) && (await dispatch<boolean>("claim_newcomer_card", { store: due.newcomer_deal, fingerprint: result.fingerprint, order: due.order }));
      if (!claimed) {
        await processor.capture(result.reference, 0, idempotencyKey("release", due.offer));
        return decline("NotEligible");
      }
    }
    // A new card takes the old one's place: not left behind at the processor.
    const replaced = state.saved[payer];
    if (result.savedAs && replaced && replaced !== result.savedAs) await processor.forget(replaced).catch((err) => this.#o.onProblem("Forget", err));
    if (result.savedAs) state.saved[payer] = result.savedAs;
    // Kept, or used: dated by the offer -- as a withdrawal is, by its payer --
    // so an offer answered after a withdrawal never reads as later than it.
    if (result.savedAs || (due.token === null && !due.resumes)) state.savedAt[payer] = Math.min(now(), due.offered_at / 1000);
    state.known[payer] = true;
    // Bound to its account on disk before the network hears of it: a
    // crash between the two never leaves a hold no account claims.
    state.heldWith[result.reference] = this.#o.account;
    await this.#o.state.save(state);
    await dispatch("record_hold", { offer: due.offer, reference: result.reference });
  }

  /// A payer withdrew the card they kept here, `at` (µs): deleted from the
  /// processor -- unless they kept one again since.
  async #forget(due: Extract<PaymentDue, { Forget: unknown }>["Forget"], state: State): Promise<boolean> {
    const payer = hex(due.payer);
    const savedAs = state.saved[payer];
    if (!savedAs || due.at / 1000 < (state.savedAt[payer] ?? 0)) return false;
    await this.#o.processor.forget(savedAs);
    delete state.saved[payer];
    delete state.savedAt[payer];
    return true;
  }

  /// Deletes each card kept here that's gone unused too long. Returns how
  /// many.
  async #expireSavedCards(): Promise<number> {
    const { processor, state: store, now, onProblem } = this.#o;
    const state = await store.load();
    let expired = 0;
    let changed = false;
    for (const [payer, savedAs] of Object.entries(state.saved)) {
      // Kept before cards were dated: from now.
      if (state.savedAt[payer] === undefined) {
        state.savedAt[payer] = now();
        changed = true;
      }
      if (now() - state.savedAt[payer] < SAVED_CARD_MS) continue;
      try {
        await processor.forget(savedAs);
        delete state.saved[payer];
        delete state.savedAt[payer];
        expired += 1;
        changed = true;
      } catch (err) {
        onProblem("Forget", err);
      }
    }
    if (changed) await store.save(state);
    return expired;
  }

  /// Refuses to act on a hold placed with another account: its reference
  /// means nothing to this one. It's settled once that account is back.
  /// One placed before holds were bound belongs to the legacy account.
  #here(reference: string, state: State) {
    const placed = state.heldWith[reference] ?? state.legacy;
    if (placed !== null && placed !== this.#o.account) throw new Refused("that payment was held with a processor account that isn't connected now");
  }

  async #settle(due: Extract<PaymentDue, { Settle: unknown }>["Settle"], state: State) {
    const { dispatch, processor } = this.#o;
    if (due.captured > due.held) throw new Refused("the network asks for more than was held");
    this.#here(due.reference, state);
    await processor.capture(due.reference, due.captured, idempotencyKey("capture", due.hold, due.captured));
    await dispatch("record_settlement", { hold: due.hold, claims: due.claims });
  }

  async #refund(due: Extract<PaymentDue, { Refund: unknown }>["Refund"], state: State) {
    const { dispatch, processor } = this.#o;
    this.#here(due.reference, state);
    await processor.refund(due.reference, due.amount, idempotencyKey("refund", due.settlement, hex(due.ruling), due.amount));
    await dispatch("record_refund", { settlement: due.settlement, ruling: due.ruling, amount: due.amount });
  }
}

export { Refused, Retry };
