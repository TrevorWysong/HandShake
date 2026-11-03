// Stripe, for a payee who connected their own Stripe account: PaymentIntents
// with manual capture, confirmed with the payer's PaymentMethod (from the
// Payment Element, `cardForm.ts`). Keys: a publishable key, for the payer's
// card form, and a restricted key -- never a full secret key -- that can
// write PaymentIntents, SetupIntents, Customers and PaymentMethods, and
// nothing else (Balance, Payouts, Transfers stay out of the agent's reach).
//
// Found against Stripe's test mode (DIRECT_PAYMENTS.md): cards only, via
// `automatic_payment_methods[enabled]` with `allow_redirects=never` (newer
// API versions refuse `payment_method_types` with it); an authorization
// lasts about seven days; a capture is charged its fee on what's captured
// only, and a cancel (release) costs nothing.
import type { Authorization, AuthorizeRequest, Connection, Processor } from "../processor.ts";
import { Refused, Retry } from "../processor.ts";
import type { DeclineCode } from "../types.ts";

const API = "https://api.stripe.com/v1";

export interface StripeKeys {
  publishable_key: string;
  restricted_key: string;
}

type Fetch = typeof fetch;
type Json = Record<string, any>;

/// Stripe's form encoding, nested keys and all.
export function form(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

/// The keys, checked as far as they can be without asking Stripe: a
/// publishable key and a restricted key of the same mode.
export function checkKeys(keys: StripeKeys): { live: boolean } {
  const publishable = /^pk_(live|test)_[A-Za-z0-9]{10,200}$/.exec(keys.publishable_key.trim());
  if (!publishable) throw new Refused("That publishable key doesn't look right: it starts pk_live_ or pk_test_.");
  if (/^sk_/.test(keys.restricted_key.trim())) throw new Refused("That's a full secret key. Create a restricted key instead, so this device can only take payments.");
  const restricted = /^rk_(live|test)_[A-Za-z0-9]{10,200}$/.exec(keys.restricted_key.trim());
  if (!restricted) throw new Refused("That restricted key doesn't look right: it starts rk_live_ or rk_test_.");
  if (publishable[1] !== restricted[1]) throw new Refused("The two keys are from different modes: use both live keys, or both test keys.");
  return { live: publishable[1] === "live" };
}

/// What a declined card's Stripe error says, as the network's code.
export function declineCode(error: Json | undefined): DeclineCode {
  const code = error?.decline_code ?? error?.code;
  if (code === "insufficient_funds") return "InsufficientFunds";
  if (code === "authentication_required" || code === "card_not_authenticated") return "ActionFailed";
  return "Declined";
}

export function stripeProcessor(keys: StripeKeys, currency: string, fetchImpl: Fetch = fetch): Processor {
  const { live } = checkKeys(keys);
  const secret = keys.restricted_key.trim();

  async function call(method: "GET" | "POST", path: string, params: Record<string, string | number | boolean | undefined> = {}, idempotencyKey?: string): Promise<Json> {
    const body = form(params);
    let response: Response;
    try {
      response = await fetchImpl(`${API}${path}${method === "GET" && body ? `?${body}` : ""}`, {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/x-www-form-urlencoded",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: method === "POST" ? body : undefined,
      });
    } catch (err) {
      throw new Retry(`Stripe couldn't be reached: ${(err as Error).message}`);
    }
    const json = (await response.json().catch(() => ({}))) as Json;
    if (response.ok) return json;
    if (response.status === 429 || response.status >= 500) throw new Retry(`Stripe is busy (${response.status})`);
    if (response.status === 402 || json.error?.type === "card_error") throw new CardDeclined(declineCode(json.error));
    if (response.status === 401) throw new Refused("Stripe no longer accepts this device's key. Connect again.");
    if (response.status === 403) throw new Refused("The restricted key can't do this. Give it write access to PaymentIntents, SetupIntents, Customers and PaymentMethods.");
    throw new StripeError(json.error?.code ?? "", json.error?.message ?? `Stripe refused (${response.status})`);
  }

  /// An intent, as the network reads it.
  function outcome(intent: Json): Authorization {
    if (intent.status === "requires_capture") {
      const card = intent.latest_charge?.payment_method_details?.card;
      return { status: "held", reference: intent.id, fingerprint: card?.fingerprint ?? null, savedAs: intent.customer && intent.payment_method && intent.setup_future_usage ? `${intent.customer}:${typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method.id}` : null };
    }
    if (intent.status === "requires_action" && intent.client_secret) return { status: "action", reference: intent.id, action: intent.client_secret };
    return { status: "declined", code: declineCode(intent.last_payment_error) };
  }

  return {
    async connect(): Promise<Connection> {
      // A restricted key reads what it may: listing intents is the least
      // this agent needs, and the account's name is a courtesy.
      await call("GET", "/payment_intents", { limit: 1 });
      const account = await call("GET", "/account").catch(() => null);
      return { account: account?.settings?.dashboard?.display_name ?? account?.business_profile?.name ?? account?.id ?? "Stripe account", live, currency, publicKey: keys.publishable_key.trim(), publicAccount: "" };
    },

    async authorize(request: AuthorizeRequest): Promise<Authorization> {
      try {
        let customer: string | undefined;
        let paymentMethod = request.token ?? undefined;
        if (request.savedAs) [customer, paymentMethod] = request.savedAs.split(":");
        else if (request.save) customer = (await call("POST", "/customers", { description: "HandShake payer" }, `${request.idempotencyKey}:customer`)).id;
        const intent = await call(
          "POST",
          "/payment_intents",
          {
            amount: request.amount,
            currency: request.currency.toLowerCase(),
            capture_method: "manual",
            confirm: true,
            payment_method: paymentMethod,
            customer,
            "automatic_payment_methods[enabled]": true,
            "automatic_payment_methods[allow_redirects]": "never",
            ...(request.savedAs ? { off_session: true } : {}),
            ...(request.save && !request.savedAs ? { setup_future_usage: "off_session" } : {}),
            "metadata[order]": request.tag,
            "expand[]": "latest_charge",
          },
          request.idempotencyKey,
        );
        return outcome(intent);
      } catch (err) {
        if (err instanceof CardDeclined) return { status: "declined", code: err.code };
        throw err;
      }
    },

    async resume(reference) {
      return outcome(await call("GET", `/payment_intents/${encodeURIComponent(reference)}`, { "expand[]": "latest_charge" }));
    },

    async capture(reference, amount, idempotencyKey) {
      const path = `/payment_intents/${encodeURIComponent(reference)}`;
      try {
        if (amount === 0) await call("POST", `${path}/cancel`, {}, idempotencyKey);
        else await call("POST", `${path}/capture`, { amount_to_capture: amount }, idempotencyKey);
      } catch (err) {
        // Done before, past what Stripe remembers of the key: done is done,
        // if it's what was asked.
        if (!(err instanceof StripeError) || err.code !== "payment_intent_unexpected_state") throw err;
        const intent = await call("GET", path);
        const already = amount === 0 ? intent.status === "canceled" : intent.status === "succeeded" && intent.amount_received === amount;
        if (!already) throw new Refused(`That payment is ${intent.status} on Stripe, not as the network has it.`);
      }
    },

    async refund(reference, amount, idempotencyKey) {
      await call("POST", "/refunds", { payment_intent: reference, amount }, idempotencyKey);
    },
  };
}

class CardDeclined extends Error {
  readonly code: DeclineCode;
  constructor(code: DeclineCode) {
    super(code);
    this.code = code;
  }
}

class StripeError extends Refused {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
