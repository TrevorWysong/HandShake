// How a wake reaches a device: one sender per channel. Every wake is the
// same content-free nudge -- no order, name or amount -- so the push
// service (Apple's, Google's, a browser vendor's) learns only that the app
// was woken. The app builds what it shows from its own state.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/// What became of a wake: delivered to the push service, refused because
/// the device no longer exists there (so the relay forgets it), or failed
/// for now.
export type Outcome = "sent" | "gone" | "failed";

export interface Sender {
  /// Whether `address` is one this channel delivers to -- asked when a
  /// device registers, and again before every wake.
  accepts(address: string): boolean;
  send(address: string): Promise<Outcome>;
}

/// The HTTP a sender needs, injectable so tests needn't reach the network.
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/// How long a push service has to answer one wake, before it's given up as
/// failed: so a service that stops answering ties up none of the relay's
/// few delivery slots for long (a wake that late is little use anyway).
export const DELIVERY_TIMEOUT_MS = 10_000;

/// `fetch`, with every request given up at the deadline -- its answer's
/// body too.
export function withDeadline(fetch: Fetch, ms = DELIVERY_TIMEOUT_MS): Fetch {
  return (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/// A signed JWT: ES256 (raw r||s, as JOSE wants) or RS256.
export function jwt(alg: "ES256" | "RS256", header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject | string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ typ: "JWT", alg, ...header })}.${encode(claims)}`;
  const privateKey = typeof key === "string" ? createPrivateKey(key) : key;
  const signature = sign("sha256", Buffer.from(input), alg === "ES256" ? { key: privateKey, dsaEncoding: "ieee-p1363" } : privateKey);
  return `${input}.${signature.toString("base64url")}`;
}
