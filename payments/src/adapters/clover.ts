// Clover, for a payee who connected their own Clover merchant: Ecommerce
// API charges with `capture: false`, captured for what's due, or released
// by refunding the uncaptured charge (which voids it). Keys: the merchant
// id and public (PAKMS) key, for the payer's card form (Clover's iframe
// fields), and an Ecommerce private token. Clover has no challenge to
// resume. A card's fingerprint, where Clover gives none, is made from what
// it does say of the card (its first six and last four digits and expiry),
// so one card still takes a store's first-order deal once.
//
// Which of Clover's environments the keys are for isn't in them: the agent
// asks production first, then the sandbox. Not yet run against Clover's
// sandbox: see DIRECT_PAYMENTS.md.
import { createHash } from "node:crypto";
import type { Authorization, AuthorizeRequest, Connection, Processor } from "../processor.ts";
import { Refused, Retry } from "../processor.ts";
import type { DeclineCode } from "../types.ts";

export interface CloverKeys {
  merchant_id: string;
  public_key: string;
  private_token: string;
}

const HOSTS = {
  live: { api: "https://api.clover.com", charges: "https://scl.clover.com" },
  sandbox: { api: "https://apisandbox.dev.clover.com", charges: "https://scl-sandbox.dev.clover.com" },
};
type Fetch = typeof fetch;
type Json = Record<string, any>;

export function checkKeys(keys: CloverKeys): void {
  if (!/^[A-Za-z0-9]{8,32}$/.test(keys.merchant_id.trim())) throw new Refused("That merchant ID doesn't look right.");
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(keys.public_key.trim())) throw new Refused("That public key doesn't look right.");
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(keys.private_token.trim())) throw new Refused("That private token doesn't look right.");
}

/// A declined charge's error, as the network's code.
export function declineCode(error: Json | undefined): DeclineCode {
  const code = error?.declineCode ?? error?.code;
  if (code === "insufficient_funds") return "InsufficientFunds";
  return "Declined";
}

/// The card's fingerprint: Clover's, or one made from what it says of it.
export function fingerprintOf(source: Json | undefined): string | null {
  if (!source) return null;
  if (typeof source.fingerprint === "string") return source.fingerprint;
  if (!source.first6 || !source.last4 || !source.exp_month || !source.exp_year) return null;
  return `fp_${createHash("sha256").update(`${source.first6}:${source.last4}:${source.exp_month}:${source.exp_year}`).digest("hex").slice(0, 24)}`;
}

export function cloverProcessor(keys: CloverKeys, currency: string, fetchImpl: Fetch = fetch): Processor {
  checkKeys(keys);
  const merchant = keys.merchant_id.trim();
  let hosts: (typeof HOSTS)["live"] | null = null;
  let live = true;
  /// The merchant, as Clover described it when the keys were first used.
  let found: Json = {};

  async function call(host: string, method: "GET" | "POST", path: string, body?: Json, idempotencyKey?: string): Promise<Json> {
    let response: Response;
    try {
      response = await fetchImpl(`${host}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${keys.private_token.trim()}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Retry(`Clover couldn't be reached: ${(err as Error).message}`);
    }
    const json = (await response.json().catch(() => ({}))) as Json;
    if (response.ok) return json;
    if (response.status === 429 || response.status >= 500) throw new Retry(`Clover is busy (${response.status})`);
    if (response.status === 401) throw new Unauthorized("Clover no longer accepts this device's token. Connect again.");
    if (response.status === 402 || json.error?.type === "card_error") throw new CardDeclined(declineCode(json.error));
    throw new Refused(json.error?.message ?? `Clover refused (${response.status})`);
  }

  /// The environment the keys are for: production, else the sandbox.
  async function environment() {
    if (hosts) return hosts;
    for (const [name, candidate] of Object.entries(HOSTS)) {
      try {
        found = await call(candidate.api, "GET", `/v3/merchants/${encodeURIComponent(merchant)}`);
        hosts = candidate;
        live = name === "live";
        return candidate;
      } catch (err) {
        if (!(err instanceof Unauthorized)) throw err;
      }
    }
    throw new Refused("Clover doesn't recognise this token for that merchant.");
  }
  const charges = async (method: "GET" | "POST", path: string, body?: Json, key?: string) => call((await environment()).charges, method, path, body, key);

  return {
    async connect(): Promise<Connection> {
      await environment();
      return { account: found.name ?? "Clover merchant", live, currency: found.defaultCurrency ?? currency, publicKey: keys.public_key.trim(), publicAccount: merchant };
    },

    async authorize(request: AuthorizeRequest): Promise<Authorization> {
      try {
        let source = request.savedAs ?? request.token ?? "";
        let savedAs: string | null = null;
        if (request.save && !request.savedAs && request.token) {
          const customer = await charges("POST", "/v1/customers", { ecomind: "ecom", source: request.token }, `${request.idempotencyKey.slice(0, 30)}:customer`);
          source = savedAs = customer.id;
        }
        const charge = await charges(
          "POST",
          "/v1/charges",
          { amount: request.amount, currency: request.currency.toLowerCase(), source, capture: false, ecomind: "ecom", external_reference_id: request.tag.slice(0, 12) },
          request.idempotencyKey,
        );
        if (charge.status !== "succeeded" || charge.captured) return { status: "declined", code: "Declined" };
        return { status: "held", reference: charge.id, fingerprint: fingerprintOf(charge.source), savedAs };
      } catch (err) {
        if (err instanceof CardDeclined) return { status: "declined", code: err.code };
        throw err;
      }
    },

    async resume() {
      return { status: "declined", code: "ActionFailed" };
    },

    async capture(reference, amount, idempotencyKey) {
      const charge = await charges("GET", `/v1/charges/${encodeURIComponent(reference)}`);
      if (charge.captured) {
        if (amount > 0 && charge.amount_captured === amount) return;
        throw new Refused("That charge is already captured on Clover, not as the network has it.");
      }
      if (amount === 0) {
        if (charge.refunded) return;
        await charges("POST", "/v1/refunds", { charge: reference }, idempotencyKey);
        return;
      }
      if (amount > charge.amount) throw new Refused("more than was held");
      await charges("POST", `/v1/charges/${encodeURIComponent(reference)}/capture`, { amount }, idempotencyKey);
    },

    async refund(reference, amount, idempotencyKey) {
      await charges("POST", "/v1/refunds", { charge: reference, amount }, idempotencyKey);
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

class Unauthorized extends Refused {}
