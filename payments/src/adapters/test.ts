// The test processor, for test networks only (the network refuses a test
// payment profile on a live one): authorizations in memory, behaving as a
// card processor does -- holds for exactly the amount, captures no more
// than was held, releases, refunds no more than was captured -- with the
// same answers for the same idempotency key. An authorization it no longer
// remembers (the agent restarted) is taken as held, as the network says.
// Test cards are tokens
// `tok_test_<anything>`; a few ending in Stripe's well-known numbers behave
// as those cards do:
//
//   tok_test_0002  declined          tok_test_9995  insufficient funds
//   tok_test_3155  asks the payer's bank to confirm, then holds
import { createHash } from "node:crypto";
import type { Authorization, AuthorizeRequest, Connection, Processor } from "../processor.ts";
import { Refused } from "../processor.ts";

interface Held {
  amount: number;
  captured: number | null;
  refunded: number;
  fingerprint: string;
}

export function testProcessor(currency: string): Processor & { held: Map<string, Held> } {
  const held = new Map<string, Held>();
  /// What each idempotency key did, to answer a retry the same way.
  const done = new Map<string, unknown>();
  const once = async <T>(key: string, what: string, act: () => T): Promise<T> => {
    const k = `${what}:${key}`;
    if (!done.has(k)) done.set(k, act());
    return done.get(k) as T;
  };
  const reference = (key: string) => `test_auth_${key.slice(0, 24)}`;
  const holding = (key: string, fingerprint: string, savedAs: string | null, amount: number): Authorization => {
    const ref = reference(key);
    if (!held.has(ref)) held.set(ref, { amount, captured: null, refunded: 0, fingerprint });
    return { status: "held", reference: ref, fingerprint, savedAs };
  };
  const pending = new Map<string, { amount: number; fingerprint: string; savedAs: string | null }>();

  return {
    held,
    async connect(): Promise<Connection> {
      return { account: "Test account", live: false, currency, publicKey: "test", publicAccount: "", country: "" };
    },
    async authorize(request: AuthorizeRequest) {
      return once(request.idempotencyKey, "authorize", (): Authorization => {
        if (request.currency !== currency) return { status: "declined", code: "Unavailable" };
        const card = request.token ?? request.savedAs;
        if (!card || !/^(tok_test_|cus_test_)/.test(card)) return { status: "declined", code: "Declined" };
        const number = card.replace(/^(tok|cus)_test_/, "");
        if (number.endsWith("0002")) return { status: "declined", code: "Declined" };
        if (number.endsWith("9995")) return { status: "declined", code: "InsufficientFunds" };
        const fingerprint = `fp_${createHash("sha256").update(number).digest("hex").slice(0, 16)}`;
        const savedAs = request.save ? `cus_test_${number}` : null;
        if (number.endsWith("3155") && request.token) {
          pending.set(reference(request.idempotencyKey), { amount: request.amount, fingerprint, savedAs });
          return { status: "action", reference: reference(request.idempotencyKey), action: `test_challenge_${request.idempotencyKey.slice(0, 12)}` };
        }
        return holding(request.idempotencyKey, fingerprint, savedAs, request.amount);
      });
    },
    async resume(ref, idempotencyKey) {
      return once(idempotencyKey, "resume", (): Authorization => {
        const waiting = pending.get(ref);
        if (!waiting) return { status: "declined", code: "ActionFailed" };
        pending.delete(ref);
        held.set(ref, { amount: waiting.amount, captured: null, refunded: 0, fingerprint: waiting.fingerprint });
        return { status: "held", reference: ref, fingerprint: waiting.fingerprint, savedAs: waiting.savedAs };
      });
    },
    async capture(ref, amount, idempotencyKey) {
      await once(idempotencyKey, "capture", () => {
        const hold = held.get(ref);
        if (!hold) return;
        if (hold.captured !== null) throw new Refused("already captured or released");
        if (amount > hold.amount) throw new Refused("more than was held");
        hold.captured = amount;
      });
    },
    async forget() {},

    async refund(ref, amount, idempotencyKey) {
      await once(idempotencyKey, "refund", () => {
        const hold = held.get(ref);
        if (!hold) return;
        if (hold.captured === null) throw new Refused("nothing captured to refund");
        if (hold.refunded + amount > hold.captured) throw new Refused("more than was captured");
        hold.refunded += amount;
      });
    },
  };
}
