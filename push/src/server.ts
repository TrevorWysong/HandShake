// The relay's HTTP face, for the app:
//
//   GET    /config                               -> {channels, vapidPublicKey}
//   POST   /devices          {channel, address}  -> {device, secret, tokens, expiresAt}
//   POST   /devices/tokens   {device, secret}    -> {tokens, expiresAt}   (a fresh batch)
//   DELETE /devices          {device, secret}    -> {}         (forget it)
//   POST   /wake             {token}             -> {}         (always the same)
//   GET    /health
//
// A device registers once and gets wake tokens in batches, to hand one to
// each party that should be able to wake it about an order (docs/MOBILE.md). A
// wake names only a token: the relay learns that some device was woken,
// not who asked or about what, and answers every wake alike so nobody can
// use it to test a token. Each device is woken a few times a minute at
// most, and so often a day; each address may ask for only so many wakes a
// minute; and wakes are delivered a few at a time, from a bounded queue, so
// a flood of requests -- valid tokens or not -- can't exhaust the relay.
//
// Registering needs no account, so nothing stops someone making up
// addresses that look real. What bounds them: each address registers only
// so many devices a day; the relay holds only so many in all, and past that
// refuses new ones rather than grow; and a device that hasn't asked for
// tokens in a token's lifetime -- so none of its tokens still work -- is
// forgotten (`Store.forgetUnseenSince`, run by main.ts). The app asks for
// a fresh batch before its tokens run out.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Outcome, Sender } from "./channels/channel.ts";
import type { Channel, Store } from "./store.ts";
import { mintToken, openToken } from "./tokens.ts";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_ADDRESS_CHARS = 4 * 1024;
const TOKENS_PER_BATCH = 20;
/// Wakes delivered at once, and waiting to be: past that, a wake is dropped.
const SENDING = 16;
const WAITING = 1024;
/// The addresses each limit remembers at once. Past that the longest-known
/// is let go, so a flood from many addresses can't grow the relay's memory
/// -- and frees only addresses that flood itself crowded out.
const ADDRESSES_REMEMBERED = 100_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface Deps {
  store: Store;
  /// The relay's token key: 32 bytes.
  tokenKey: Buffer;
  /// The channels this relay delivers on.
  senders: Partial<Record<Channel, Sender>>;
  vapidPublicKey: string | null;
  /// How long a token works for, from when it's made.
  tokenTtlMs: number;
  wakesPerMinute: number;
  wakesPerDay: number;
  /// Registrations and token batches one address may ask for an hour.
  requestsPerIpPerHour: number;
  /// Devices one address may register a day.
  registrationsPerIpPerDay: number;
  /// The most devices the relay holds: past it, registering is refused.
  maxDevices: number;
  /// Wakes one address may ask for a minute, valid tokens or not.
  wakeRequestsPerIpPerMinute: number;
  /// How many addresses each limit remembers -- for tests.
  addressesRemembered?: number;
  /// How many wakes are delivered at once, and may wait -- for tests.
  wakeQueue?: { sending: number; waiting: number };
  appOrigins: string[];
  trustProxy: boolean;
  log?: (message: string) => void;
  /// Called once a wake has been delivered or given up on -- for tests.
  onWake?: (outcome: Outcome | "dropped") => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Falls through.
  }
  throw new HttpError(400, "Send a JSON object.");
}

function text(value: unknown, what: string, max = 200): string {
  if (typeof value !== "string" || !value || value.length > max) throw new HttpError(400, `Which ${what}?`);
  return value;
}

/// Whom a request counts against: an IPv4 address, or an IPv6 address's
/// /64 -- a subscriber's whole allocation, which they can rotate through at
/// will.
export function requester(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("%")[0].split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/// A count of what happened since `from` (ms), in a window of fixed length.
interface Window {
  from: number;
  n: number;
}

/// `counted` as it stands at `now`: a new window once its own has run.
function current(counted: Window | undefined, windowMs: number, now: number): Window {
  return counted && now - counted.from < windowMs ? counted : { from: now, n: 0 };
}

export function handler(deps: Deps) {
  const { store, tokenKey, senders, log = () => {}, onWake = () => {}, wakeQueue = { sending: SENDING, waiting: WAITING }, addressesRemembered = ADDRESSES_REMEMBERED } = deps;
  const channels = Object.keys(senders) as Channel[];

  /// How often each device was woken lately, for its limits: a count per
  /// minute and per day, each from when its window began -- a few numbers a
  /// device, however often it's woken. Kept in memory: a restart forgets
  /// it, which only ever loosens a limit for a while.
  const woken = new Map<string, { minute: Window; day: Window }>();
  function mayWake(device: string): boolean {
    const now = Date.now();
    const counts = woken.get(device) ?? { minute: { from: now, n: 0 }, day: { from: now, n: 0 } };
    const minute = current(counts.minute, MINUTE_MS, now);
    const day = current(counts.day, DAY_MS, now);
    if (day.n >= deps.wakesPerDay || minute.n >= deps.wakesPerMinute) return false;
    woken.set(device, { minute: { from: minute.from, n: minute.n + 1 }, day: { from: day.from, n: day.n + 1 } });
    return true;
  }

  /// Refuses an address its `limit`th request within `windowMs`.
  function perAddress(limit: number, windowMs: number) {
    const requests = new Map<string, Window>();
    let swept = Date.now();
    return (req: IncomingMessage) => {
      const now = Date.now();
      if (now - swept > windowMs) {
        for (const [address, counted] of requests) if (now - counted.from >= windowMs) requests.delete(address);
        for (const [device, counts] of woken) if (now - counts.day.from >= DAY_MS) woken.delete(device);
        swept = now;
      }
      // The address the trusted proxy saw -- the last it added. Anything
      // before it came from the client, who can write what they like.
      const forwarded = deps.trustProxy ? (String(req.headers["x-forwarded-for"] ?? "").split(",").pop() ?? "").trim() : "";
      const address = requester(forwarded || req.socket.remoteAddress || "unknown");
      const counted = current(requests.get(address), windowMs, now);
      if (counted.n >= limit) throw new HttpError(429, "Too many requests from here. Try again later.");
      // Kept newest last, so the first is the one known longest.
      requests.delete(address);
      if (requests.size >= addressesRemembered) requests.delete(requests.keys().next().value!);
      requests.set(address, { from: counted.from, n: counted.n + 1 });
    };
  }
  const throttle = perAddress(deps.requestsPerIpPerHour, HOUR_MS);
  const throttleWakes = perAddress(deps.wakeRequestsPerIpPerMinute, MINUTE_MS);
  const throttleRegistrations = perAddress(deps.registrationsPerIpPerDay, DAY_MS);

  // Wakes waiting to be delivered, a few at a time.
  const waiting: string[] = [];
  let sending = 0;
  function queueWake(token: string) {
    if (waiting.length >= wakeQueue.waiting) return onWake("dropped");
    waiting.push(token);
    deliverWaiting();
  }
  function deliverWaiting() {
    while (sending < wakeQueue.sending && waiting.length > 0) {
      sending += 1;
      void wake(waiting.shift()!).finally(() => {
        sending -= 1;
        deliverWaiting();
      });
    }
  }

  /// A fresh batch of tokens, and when they stop working -- so the app
  /// knows to ask for more before then.
  const batch = (device: string) => {
    const expiresAt = Date.now() + deps.tokenTtlMs;
    store.seen(device);
    return { tokens: Array.from({ length: TOKENS_PER_BATCH }, () => mintToken(tokenKey, { device, expiresAt })), expiresAt };
  };

  function authenticated(body: Record<string, unknown>) {
    const device = store.authenticate(text(body.device, "device"), text(body.secret, "secret"));
    if (!device) throw new HttpError(404, "This device isn't registered here. Register it again.");
    return device;
  }

  /// Delivers a wake in the background: whoever asked learns nothing of
  /// what became of it.
  async function wake(token: string) {
    const opened = openToken(tokenKey, token);
    const device = opened && opened.expiresAt > Date.now() ? store.device(opened.device) : null;
    const sender = device && senders[device.channel];
    if (!device || !sender || !mayWake(device.id)) return onWake("dropped");
    let outcome: Outcome;
    try {
      outcome = await sender.send(device.address);
    } catch (err) {
      log(`a ${device.channel} wake failed: ${err instanceof Error ? err.message : String(err)}`);
      outcome = "failed";
    }
    if (outcome === "gone") store.forget(device.id);
    onWake(outcome);
  }

  const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    "GET /health": async () => ({ ok: true }),
    "GET /config": async () => ({ channels, vapidPublicKey: deps.vapidPublicKey }),
    "POST /devices": async (req) => {
      throttle(req);
      const body = await json(req);
      const channel = text(body.channel, "channel") as Channel;
      if (!channels.includes(channel)) throw new HttpError(400, "This relay doesn't deliver that way.");
      const address = text(body.address, "address", MAX_ADDRESS_CHARS);
      if (!senders[channel]!.accepts(address)) throw new HttpError(400, "That isn't an address this relay delivers to.");
      throttleRegistrations(req);
      if (store.count() >= deps.maxDevices) {
        log(`full: ${deps.maxDevices} devices held, a registration refused`);
        throw new HttpError(503, "This relay can't take more devices just now. Try again later.");
      }
      const { id, secret } = store.register(channel, address);
      return { device: id, secret, ...batch(id) };
    },
    "POST /devices/tokens": async (req) => {
      throttle(req);
      return batch(authenticated(await json(req)).id);
    },
    "DELETE /devices": async (req) => {
      store.forget(authenticated(await json(req)).id);
      return {};
    },
    "POST /wake": async (req) => {
      throttleWakes(req);
      const token = (await json(req)).token;
      if (typeof token === "string" && token.length <= 512) queueWake(token);
      return {};
    },
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && deps.appOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const route = routes[`${req.method} ${(req.url ?? "").split("?")[0]}`];
    try {
      if (!route) throw new HttpError(404, "Not found.");
      const result = await route(req);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`error: ${err instanceof Error ? err.stack : String(err)}`);
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: status === 500 ? "Something went wrong. Try again." : (err as Error).message }));
    }
  };
}

export function serve(deps: Deps, port: number) {
  return createServer(handler(deps)).listen(port);
}
