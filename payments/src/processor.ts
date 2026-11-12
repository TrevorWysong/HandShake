// What a payee's processor does for the agent, whichever it is (Stripe,
// Square, Clover, or the test processor): authorize a card for exactly an
// amount, with capture later; finish an authorization the card's bank
// challenged; capture part or all of it, or release it; refund an award.
// Every call that moves money takes an idempotency key, so a retry after a
// crash or a dropped connection does the same thing once, never twice.
import type { DeclineCode } from "./types.ts";

/// A processor account, as its keys reach it.
export interface Connection {
  /// The processor's name for the account, as its dashboard shows it.
  account: string;
  live: boolean;
  /// The account's currency, ISO 4217 -- it must be the network's.
  currency: string;
  /// What the payer's card form needs: the public half of the keys.
  publicKey: string;
  /// Square's location, Clover's merchant -- empty for Stripe.
  publicAccount: string;
  /// The account's country (ISO 3166, `US`), where the processor says --
  /// what wallets' payment sheets name as the seller's.
  country: string;
}

/// One processor account, as the agent tells accounts apart: its processor
/// and the public half of its keys, which no other account shares.
export const accountId = (processor: string, connection: Pick<Connection, "publicKey" | "publicAccount">) => `${processor}:${connection.publicKey}:${connection.publicAccount}`;

/// What became of an authorization.
export type Authorization =
  /// Held: `reference` is the processor's id for it.
  | { status: "held"; reference: string; fingerprint: string | null; savedAs: string | null }
  /// The card's bank wants the payer to confirm (3-D Secure): `action` is
  /// what the payer's card form needs to; `reference` resumes it.
  | { status: "action"; reference: string; action: string }
  | { status: "declined"; code: DeclineCode };

export interface AuthorizeRequest {
  amount: number;
  currency: string;
  /// The payer's single-use token -- or `null` for the card they saved,
  /// `savedAs`.
  token: string | null;
  savedAs: string | null;
  /// Keep the card for the payer's next payment here.
  save: boolean;
  /// What the processor sees of the order: an opaque tag, nothing more.
  tag: string;
  idempotencyKey: string;
}

export interface Processor {
  /// Checks the keys reach an account, of the least privilege that works.
  connect(): Promise<Connection>;
  authorize(request: AuthorizeRequest): Promise<Authorization>;
  /// The authorization at `reference`, once the payer has done what its
  /// bank asked.
  resume(reference: string, idempotencyKey: string): Promise<Authorization>;
  /// Captures `amount` of the authorization at `reference` and releases
  /// the rest -- or, `amount` 0, releases it all.
  capture(reference: string, amount: number, idempotencyKey: string): Promise<void>;
  /// Refunds `amount` of a captured payment.
  refund(reference: string, amount: number, idempotencyKey: string): Promise<void>;
  /// Deletes the card kept as `savedAs` from the account, where the
  /// processor allows it -- its payer withdrew it, or it went unused too long.
  forget(savedAs: string): Promise<void>;
}

/// A failure that passes on its own -- the processor unreachable, or busy:
/// the agent tries again on its next round.
export class Retry extends Error {}

/// A failure the agent can't fix by trying again, in words for the payee.
export class Refused extends Error {}

/// The processor has no record of what was asked about.
export class NotFound extends Refused {}

/// The processor doesn't accept the keys: mistyped, or since revoked.
export class KeyRefused extends Refused {}

/// How long a processor has to answer one request, body and all, before the
/// agent gives up on it and tries again next round -- every request carries
/// an idempotency key, so a retry is the same request. Bounded so one hung
/// connection can't stall a round, and with it every payment after it;
/// far longer than any answer takes.
export const PROCESSOR_TIMEOUT_MS = 30_000;
