// Square, for a payee who connected their own Square application: card
// payments with delayed capture (`autocomplete: false`) at the location they
// chose, then completed for what's due (lowered first, when it's less), or
// cancelled. Keys: the application id and location, for the payer's card
// form (Web Payments SDK), and the application's access token. Square's
// personal access tokens can do more than take payments, so the agent only
// ever calls the payments, refunds, customers and cards endpoints -- and
// the setup suggests a location of the payee's own for HandShake.
//
// The payer's bank is asked before the card is tokenized (`verifyBuyer`, in
// the card form), so there's no challenge to resume here. Not yet run
// against Square's sandbox: see DIRECT_PAYMENTS.md.
import { createHash } from "node:crypto";
import type { Authorization, AuthorizeRequest, Connection, Processor } from "../processor.ts";
import { KeyRefused, NotFound, Refused, Retry, PROCESSOR_TIMEOUT_MS } from "../processor.ts";
import type { DeclineCode } from "../types.ts";

export interface SquareKeys {
  application_id: string;
  location_id: string;
  access_token: string;
}

const VERSION = "2025-01-23";
type Fetch = typeof fetch;
type Json = Record<string, any>;

/// Square's idempotency keys are at most 45 characters: one derived from
/// another, for a second call answering the same record, stays within it.
const derived = (key: string, what: string) => createHash("sha256").update(`${key}:${what}`).digest("hex").slice(0, 40);

/// The keys, checked as far as they can be without asking Square; a
/// sandbox application's id starts `sandbox-`.
export function checkKeys(keys: SquareKeys): { live: boolean } {
  const application = /^(sandbox-)?sq0idp-[A-Za-z0-9_-]{10,100}$|^(sandbox-)?sq0idb-[A-Za-z0-9_-]{10,100}$/.exec(keys.application_id.trim());
  if (!application) throw new Refused("That application ID doesn't look right: it starts sq0idp- (or sandbox-sq0idb- for a sandbox).");
  if (!/^[A-Za-z0-9]{6,64}$/.test(keys.location_id.trim())) throw new Refused("That location ID doesn't look right.");
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(keys.access_token.trim())) throw new Refused("That access token doesn't look right.");
  return { live: !keys.application_id.trim().startsWith("sandbox-") };
}

/// A declined payment's first error, as the network's code.
export function declineCode(errors: Json[] | undefined): DeclineCode {
  const code = errors?.[0]?.code;
  if (code === "INSUFFICIENT_FUNDS") return "InsufficientFunds";
  if (code === "CARD_DECLINED_VERIFICATION_REQUIRED") return "ActionFailed";
  return "Declined";
}

/// What the card form hands over: the card's (or wallet's) nonce, the
/// buyer's verification token if their bank asked, and whether it came from
/// a wallet -- whose cards Square doesn't keep on file. Only ever a fresh
/// nonce: Square would take a card on file's id in its place, and a payer's
/// token is never another payer's saved card.
function readToken(token: string): { nonce: string; verification: string | null; wallet: boolean } {
  try {
    const parsed = JSON.parse(token) as { nonce?: unknown; verification?: unknown; wallet?: unknown };
    if (typeof parsed.nonce === "string" && /^[cw]non:[A-Za-z0-9_:-]{1,295}$/.test(parsed.nonce)) return { nonce: parsed.nonce, verification: typeof parsed.verification === "string" ? parsed.verification : null, wallet: parsed.wallet === true };
  } catch {
    // not the card form's
  }
  throw new CardDeclined("Declined");
}

/// A card kept here, as the agent names it: `customer:card` -- split at the
/// first colon only, since Square's card ids have one of their own
/// (`ccof:...`).
function keptCard(savedAs: string): [string, string] {
  const at = savedAs.indexOf(":");
  return at < 0 ? [savedAs, ""] : [savedAs.slice(0, at), savedAs.slice(at + 1)];
}

export function squareProcessor(keys: SquareKeys, currency: string, fetchImpl: Fetch = fetch, timeoutMs = PROCESSOR_TIMEOUT_MS): Processor {
  const { live } = checkKeys(keys);
  const base = live ? "https://connect.squareup.com/v2" : "https://connect.squareupsandbox.com/v2";
  const location = keys.location_id.trim();

  async function call(method: "GET" | "POST" | "PUT", path: string, body?: Json): Promise<Json> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${keys.access_token.trim()}`, "Square-Version": VERSION, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Retry(`Square couldn't be reached: ${(err as Error).message}`);
    }
    const json = (await response.json().catch((err: Error) => {
      // Cut off by the deadline: not an answer, but no answer yet.
      if (err.name === "TimeoutError" || err.name === "AbortError") throw new Retry(`Square didn't finish answering: ${err.message}`);
      return {};
    })) as Json;
    if (response.ok) return json;
    if (response.status === 429 || response.status >= 500) throw new Retry(`Square is busy (${response.status})`);
    if (response.status === 401) throw new KeyRefused("Square no longer accepts this device's access token. Connect again.");
    if (response.status === 403) throw new Refused("The access token can't do this. It needs payments, customers and cards.");
    if (json.errors?.some((e: Json) => e.category === "PAYMENT_METHOD_ERROR")) throw new CardDeclined(declineCode(json.errors));
    if (response.status === 404) throw new NotFound(json.errors?.[0]?.detail ?? "Square has no record of that.");
    throw new SquareError(json.errors?.[0]?.code ?? "", json.errors?.[0]?.detail ?? `Square refused (${response.status})`);
  }

  const fingerprint = (payment: Json): string | null => {
    const card = payment.card_details?.card;
    return card?.fingerprint ?? null;
  };

  return {
    async connect(): Promise<Connection> {
      const { location: found } = await call("GET", `/locations/${encodeURIComponent(location)}`);
      if (found?.status !== "ACTIVE") throw new Refused("That location isn't active on Square.");
      if (typeof found.country !== "string" || !/^[A-Z]{2}$/.test(found.country)) throw new Refused("Square didn't say which country that location is in.");
      return { account: found.business_name ?? found.name ?? "Square location", live, currency: found.currency ?? currency, publicKey: keys.application_id.trim(), publicAccount: location, country: found.country };
    },

    async authorize(request: AuthorizeRequest): Promise<Authorization> {
      try {
        let source: string;
        let customer: string | undefined;
        let verification: string | null = null;
        let wallet = false;
        if (request.savedAs) [customer, source] = keptCard(request.savedAs);
        else ({ nonce: source, verification, wallet } = readToken(request.token ?? ""));
        const { payment } = await call("POST", "/payments", {
          idempotency_key: request.idempotencyKey,
          source_id: source,
          amount_money: { amount: request.amount, currency: request.currency.toUpperCase() },
          autocomplete: false,
          location_id: location,
          reference_id: request.tag,
          ...(customer ? { customer_id: customer } : {}),
          ...(verification ? { verification_token: verification } : {}),
        });
        if (payment.status !== "APPROVED") return { status: "declined", code: "Declined" };
        // Keeping the card is a courtesy: if Square won't, the payment
        // still stands, held.
        let savedAs: string | null = null;
        if (request.save && !request.savedAs && !wallet) {
          try {
            const { customer: made } = await call("POST", "/customers", { idempotency_key: derived(request.idempotencyKey, "customer"), note: "HandShake payer" });
            const { card } = await call("POST", "/cards", { idempotency_key: derived(request.idempotencyKey, "card"), source_id: payment.id, card: { customer_id: made.id } });
            savedAs = `${made.id}:${card.id}`;
          } catch {
            savedAs = null;
          }
        }
        return { status: "held", reference: payment.id, fingerprint: fingerprint(payment), savedAs };
      } catch (err) {
        if (err instanceof CardDeclined) return { status: "declined", code: err.code };
        throw err;
      }
    },

    async resume() {
      return { status: "declined", code: "ActionFailed" };
    },

    async capture(reference, amount, idempotencyKey) {
      const path = `/payments/${encodeURIComponent(reference)}`;
      const { payment } = await call("GET", path);
      // Done before: done is done, if it's what was asked.
      if (payment.status === "CANCELED" || payment.status === "COMPLETED") {
        const already = amount === 0 ? payment.status === "CANCELED" : payment.status === "COMPLETED" && payment.amount_money?.amount === amount;
        if (already) return;
        throw new Refused(`That payment is ${payment.status} on Square, not as the network has it.`);
      }
      if (amount === 0) {
        await call("POST", `${path}/cancel`);
        return;
      }
      if (amount > payment.amount_money.amount) throw new Refused("more than was held");
      if (amount < payment.amount_money.amount) {
        await call("PUT", path, { idempotency_key: idempotencyKey, payment: { amount_money: { amount, currency: payment.amount_money.currency } } });
      }
      await call("POST", `${path}/complete`, {});
    },

    async forget(savedAs) {
      const [, card] = keptCard(savedAs);
      if (!/^[A-Za-z0-9_:-]{1,192}$/.test(card ?? "")) throw new Refused("That isn't a card kept here.");
      // A card already gone is what's asked for.
      await call("POST", `/cards/${card}/disable`).catch((err) => {
        if (!(err instanceof NotFound)) throw err;
      });
    },

    async refund(reference, amount, idempotencyKey) {
      const { payment } = await call("GET", `/payments/${encodeURIComponent(reference)}`);
      await call("POST", "/refunds", { idempotency_key: idempotencyKey, payment_id: reference, amount_money: { amount, currency: payment.amount_money.currency } });
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

class SquareError extends Refused {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
