// PayPal, for a payee who connected their own PayPal business account: the
// payer approves an order in PayPal's own window (their PayPal balance or a
// card), and the payee's agent authorizes it, captures what's due, or voids
// it. Keys: the app's client ID, for the payer's PayPal buttons, and its
// secret.
//
// The payer's side creates the order, so the agent believes none of it:
// before authorizing, it reads the order back from PayPal and holds it only
// if it's approved, for authorizing, in exactly the network's amount and
// currency, paid to the payee's own account and nobody else -- an order
// can name another payee, or split the money off, and one the payee's
// account can't read isn't theirs at all. Which account is the payee's,
// PayPal says on an order the agent makes itself (never approved, it
// lapses, costing nothing).
// A PayPal authorization is honoured for three days (and capturable for 29),
// within the network's report window. PayPal keeps no card on file here: a
// payer approves each payment. Which environment the keys are for isn't in
// them: the agent asks PayPal's live API first, then its sandbox. Not yet
// run against PayPal's sandbox: see DIRECT_PAYMENTS.md.
import type { Authorization, AuthorizeRequest, Connection, Processor } from "../processor.ts";
import { Refused, Retry } from "../processor.ts";
import type { DeclineCode } from "../types.ts";

export interface PayPalKeys {
  client_id: string;
  secret: string;
}

const HOSTS = { live: "https://api-m.paypal.com", sandbox: "https://api-m.sandbox.paypal.com" };
type Fetch = typeof fetch;
type Json = Record<string, any>;

export function checkKeys(keys: PayPalKeys): void {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(keys.client_id.trim())) throw new Refused("That client ID doesn't look right.");
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(keys.secret.trim())) throw new Refused("That secret doesn't look right.");
}

/// How many decimal places `currency` has (2 for dollars, 0 for yen).
const decimals = (currency: string) => new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;

/// An amount in minor units as PayPal's decimal string ("12.50").
export function majorUnits(cents: number, currency: string): string {
  const digits = decimals(currency);
  return (cents / 10 ** digits).toFixed(digits);
}

/// A refusal's first issue, as the network's code.
export function declineCode(json: Json | undefined): DeclineCode {
  const issue = json?.details?.[0]?.issue;
  if (issue === "PAYER_ACTION_REQUIRED") return "ActionFailed";
  if (issue === "INSUFFICIENT_FUNDS" || issue === "PAYER_CANNOT_PAY") return "InsufficientFunds";
  return "Declined";
}

export function paypalProcessor(keys: PayPalKeys, currency: string, fetchImpl: Fetch = fetch): Processor {
  checkKeys(keys);
  let host: string | null = null;
  let live = true;
  let token: { value: string; until: number } | null = null;
  let own: Promise<string> | null = null;

  async function send(base: string, method: "GET" | "POST", path: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    try {
      return await fetchImpl(`${base}${path}`, { method, headers: init.headers, body: init.body });
    } catch (err) {
      throw new Retry(`PayPal couldn't be reached: ${(err as Error).message}`);
    }
  }

  /// An access token for `base`, or `null` where PayPal doesn't know the keys.
  async function tokenFor(base: string): Promise<string | null> {
    const basic = Buffer.from(`${keys.client_id.trim()}:${keys.secret.trim()}`).toString("base64");
    const response = await send(base, "POST", "/v1/oauth2/token", { body: "grant_type=client_credentials", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" } });
    if (response.status === 401) return null;
    if (response.status === 429 || response.status >= 500) throw new Retry(`PayPal is busy (${response.status})`);
    if (!response.ok) throw new Refused(`PayPal refused the keys (${response.status})`);
    const json = (await response.json()) as Json;
    token = { value: json.access_token, until: Date.now() + (Number(json.expires_in ?? 0) - 60) * 1000 };
    return token.value;
  }

  /// The environment the keys are for, and a current token there.
  async function authorized(): Promise<string> {
    if (host && token && Date.now() < token.until) return token.value;
    if (host) {
      const again = await tokenFor(host);
      if (!again) throw new Refused("PayPal no longer accepts this device's keys. Connect again.");
      return again;
    }
    for (const [name, base] of Object.entries(HOSTS)) {
      const found = await tokenFor(base);
      if (found) {
        host = base;
        live = name === "live";
        return found;
      }
    }
    throw new Refused("PayPal doesn't recognise those keys, live or sandbox.");
  }

  async function call(method: "GET" | "POST", path: string, body?: Json, idempotencyKey?: string): Promise<Json> {
    const bearer = await authorized();
    const response = await send(host!, method, path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(idempotencyKey ? { "PayPal-Request-Id": idempotencyKey } : {}),
      },
    });
    const json = (await response.json().catch(() => ({}))) as Json;
    if (response.ok) return json;
    if (response.status === 429 || response.status >= 500) throw new Retry(`PayPal is busy (${response.status})`);
    if (response.status === 401) throw new Refused("PayPal no longer accepts this device's keys. Connect again.");
    if (response.status === 404) throw new NotOurs();
    if (response.status === 422) throw new PayPalRefusal(json);
    throw new Refused(json.message ?? `PayPal refused (${response.status})`);
  }

  /// The order and authorization a hold's reference names.
  const split = (reference: string) => {
    const [order, authorization] = reference.split("_");
    if (!order || !authorization) throw new Refused("That isn't a PayPal hold's reference.");
    return { order, authorization };
  };
  const capturedOn = (order: Json): Json[] => order.purchase_units?.[0]?.payments?.captures ?? [];

  /// The payee's own merchant ID, as PayPal names it on an order made here.
  function ownMerchant(): Promise<string> {
    own ??= call("POST", "/v2/checkout/orders", { intent: "AUTHORIZE", purchase_units: [{ amount: { currency_code: currency.toUpperCase(), value: majorUnits(100, currency) } }] })
      .then((order) => {
        const id = order.purchase_units?.[0]?.payee?.merchant_id;
        if (typeof id !== "string" || !id) throw new Refused("PayPal didn't say which account these keys pay into.");
        return id;
      })
      .catch((err) => {
        own = null;
        throw err;
      });
    return own;
  }

  return {
    async connect(): Promise<Connection> {
      await ownMerchant();
      return { account: "PayPal account", live, currency, publicKey: keys.client_id.trim(), publicAccount: "", country: "" };
    },

    async authorize(request: AuthorizeRequest): Promise<Authorization> {
      const orderId = request.token ?? "";
      if (!/^[A-Z0-9]{8,40}$/.test(orderId)) return { status: "declined", code: "Declined" };
      try {
        const merchant = await ownMerchant();
        const order = await call("GET", `/v2/checkout/orders/${orderId}`);
        const unit = order.purchase_units?.[0];
        const exact = order.intent === "AUTHORIZE" && order.status === "APPROVED" && order.purchase_units?.length === 1 && unit?.amount?.currency_code === request.currency.toUpperCase() && unit?.amount?.value === majorUnits(request.amount, request.currency);
        const ours = unit?.payee?.merchant_id === merchant && unit?.payment_instruction === undefined;
        if (!exact || !ours) return { status: "declined", code: "Declined" };
        const done = await call("POST", `/v2/checkout/orders/${orderId}/authorize`, {}, request.idempotencyKey);
        const authorization = done.purchase_units?.[0]?.payments?.authorizations?.[0];
        if (!authorization?.id || authorization.status !== "CREATED") return { status: "declined", code: "Declined" };
        return { status: "held", reference: `${orderId}_${authorization.id}`, fingerprint: done.payer?.payer_id ?? order.payer?.payer_id ?? null, savedAs: null };
      } catch (err) {
        if (err instanceof NotOurs) return { status: "declined", code: "Declined" };
        if (err instanceof PayPalRefusal) return { status: "declined", code: declineCode(err.json) };
        throw err;
      }
    },

    async resume() {
      return { status: "declined", code: "ActionFailed" };
    },

    async capture(reference, amount, idempotencyKey) {
      const { order, authorization } = split(reference);
      try {
        if (amount === 0) await call("POST", `/v2/payments/authorizations/${authorization}/void`, undefined, idempotencyKey);
        else await call("POST", `/v2/payments/authorizations/${authorization}/capture`, { amount: { value: majorUnits(amount, currency), currency_code: currency.toUpperCase() }, final_capture: true }, idempotencyKey);
      } catch (err) {
        // Done before: done is done, if it's what was asked.
        if (!(err instanceof PayPalRefusal)) throw err;
        const state = await call("GET", `/v2/payments/authorizations/${authorization}`);
        const minor = 10 ** decimals(currency);
        const captured = capturedOn(await call("GET", `/v2/checkout/orders/${order}`)).reduce((sum, c) => sum + Math.round(Number(c.amount?.value ?? 0) * minor), 0);
        const already = amount === 0 ? state.status === "VOIDED" : state.status === "CAPTURED" && captured === amount;
        if (!already) throw new Refused(`That payment is ${String(state.status).toLowerCase()} on PayPal, not as the network has it.`);
      }
    },

    async refund(reference, amount, idempotencyKey) {
      const { order } = split(reference);
      const [capture] = capturedOn(await call("GET", `/v2/checkout/orders/${order}`));
      if (!capture?.id) throw new Refused("There's no PayPal capture to refund.");
      await call("POST", `/v2/payments/captures/${capture.id}/refund`, { amount: { value: majorUnits(amount, currency), currency_code: currency.toUpperCase() } }, idempotencyKey);
    },
  };
}

class NotOurs extends Error {}

class PayPalRefusal extends Error {
  readonly json: Json;
  constructor(json: Json) {
    super(json?.details?.[0]?.issue ?? "refused");
    this.json = json;
  }
}
