// Waking this app when it's closed (docs/MOBILE.md, "Waking a closed app"): the
// network's push relay (`push/`, its `services.push_relay_url`) holds how to
// reach this device, and hands it wake tokens that name it to nobody else.
// Each order carries two of them, sealed: one for the store, one for the
// driver, who hand theirs to the relay when the order changes. The relay
// sends a push with nothing in it; what the person sees is built here.
//
// How the device is reached is the runtime's: a phone app's runtime hands
// over its APNs or FCM token as `window.__HANDSHAKE_PUSH__`; in a browser it's
// a Web Push subscription, through the service worker (src/sw.ts).
import { useNetwork } from "../../store/network";
import { t, useLocale } from "../../i18n";
import { forget, readStoredJson, store } from "../util/storage";

/// What a phone app's runtime provides: the platform's push token for this
/// install, after asking the person's permission.
export interface PushRuntime {
  register(): Promise<{ channel: "apns" | "fcm"; address: string }>;
}

declare global {
  interface Window {
    __HANDSHAKE_PUSH__?: PushRuntime;
  }
}

/// A wake token, and when the relay stops honouring it.
interface HeldToken {
  token: string;
  expiresAt: number;
}

interface Registration {
  relay: string;
  device: string;
  secret: string;
  tokens: HeldToken[];
}

/// A batch of tokens, as the relay hands them out.
interface Batch {
  tokens: string[];
  expiresAt: number;
}

const KEY = "handshake.push";
/// Fetch a new batch before the last few are handed out.
const REFILL_BELOW = 8;
/// What a token handed to an order has left to live, at least: enough for
/// the order to run its course, scheduled ahead or slow to settle.
const LIFE_LEFT_MS = 7 * 24 * 60 * 60 * 1000;

/// This device's registration, holding only tokens that will still work
/// through an order -- and none from before batches said when they expire.
function registration(): Registration | null {
  const stored = readStoredJson<Omit<Registration, "tokens"> & { tokens: unknown[] }>(KEY);
  if (!stored) return null;
  const until = Date.now() + LIFE_LEFT_MS;
  const tokens = stored.tokens.filter((held): held is HeldToken => typeof held === "object" && held !== null && typeof (held as HeldToken).token === "string" && (held as HeldToken).expiresAt > until);
  return { ...stored, tokens };
}

const held = ({ tokens, expiresAt }: Batch): HeldToken[] => tokens.map((token) => ({ token, expiresAt }));

/// The relay the network runs, if any.
function relayUrl(): string | null {
  return useNetwork.getState().terms?.push_relay_url?.replace(/\/$/, "") ?? null;
}

function webPushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window;
}

/// Whether this device can be woken while closed: the network runs a relay,
/// and the runtime or browser can receive its pushes.
export function canWakeWhileClosed(): boolean {
  return !!relayUrl() && (!!window.__HANDSHAKE_PUSH__ || webPushSupported());
}

/// Whether this device is set up to be woken through the network's relay.
export function wakesWhileClosed(): boolean {
  const current = registration();
  return !!current && current.relay === relayUrl();
}

/// How long the relay has to answer: a wake, a registration, its settings.
const RELAY_TIMEOUT_MS = 10_000;

async function post<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(answer.error ?? `The push relay answered ${response.status}.`), { status: response.status });
  return answer;
}

/// Registers this device with the network's relay: asks for permission
/// (the runtime's, or the browser's), then where the relay reaches it.
export async function startWakingWhileClosed(): Promise<void> {
  await register(false);
}

/// `startWakingWhileClosed`; `renew` for a device the relay has forgotten,
/// whose browser subscription may be the reason, so it's made afresh.
async function register(renew: boolean): Promise<void> {
  const relay = relayUrl();
  if (!relay) throw new Error(t("error.pushNoRelay"));
  let target: { channel: string; address: string };
  if (window.__HANDSHAKE_PUSH__) {
    target = await window.__HANDSHAKE_PUSH__.register();
  } else {
    const { vapidPublicKey } = (await (await fetch(`${relay}/config`, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) })).json()) as { vapidPublicKey: string | null };
    if (!vapidPublicKey) throw new Error(t("error.pushNoBrowsers"));
    if ((await Notification.requestPermission()) !== "granted") throw new Error(t("error.pushBlocked"));
    const worker = await navigator.serviceWorker.ready;
    const existing = await worker.pushManager.getSubscription();
    if (renew) await existing?.unsubscribe();
    const subscription = (!renew && existing) || (await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesFromBase64Url(vapidPublicKey) }));
    target = { channel: "webpush", address: JSON.stringify(subscription) };
  }
  const { device, secret, ...batch } = await post<{ device: string; secret: string } & Batch>(`${relay}/devices`, target);
  store(KEY, JSON.stringify({ relay, device, secret, tokens: held(batch) } satisfies Registration));
}

/// The relay forgot this device -- its address went stale, or it went
/// unused for a token's lifetime. It's registered again, without asking
/// anyone: only where permission's already given, else waking stops (the
/// settings switch then shows off).
function registerAgain(): void {
  forget(KEY);
  const permitted = !!window.__HANDSHAKE_PUSH__ || (webPushSupported() && Notification.permission === "granted");
  if (permitted) void register(true).catch(() => forget(KEY));
}

/// Keeps this device wakeable: on every start, a fresh batch when the
/// tokens it holds are running low or running out -- which also keeps the
/// relay from forgetting it.
export function keepWakeable(): void {
  const current = registration();
  if (current && current.relay === relayUrl() && current.tokens.length < REFILL_BELOW) refill(current);
}

/// A registration this device let go of, whose relay hasn't yet heard it
/// to forget: asked again until it has (`forgetPending`).
const FORGETTING_KEY = "handshake.push.forgetting";

/// Asks a relay to forget `gone`: `true` once it has (or never knew it).
async function forgetAt(gone: Registration): Promise<boolean> {
  try {
    await post(`${gone.relay}/devices`, { device: gone.device, secret: gone.secret }, "DELETE");
    return true;
  } catch (err) {
    return (err as { status?: number }).status === 404;
  }
}

/// Has the relay forget this device: every token it handed out stops
/// working. This device stops at once; if the relay can't be told just now,
/// it's told later (`forgetPending`), never left holding a registration
/// nobody uses.
export async function stopWakingWhileClosed(): Promise<void> {
  const current = registration();
  forget(KEY);
  if (current && !(await forgetAt(current))) {
    const pending = readStoredJson<Registration[]>(FORGETTING_KEY) ?? [];
    store(FORGETTING_KEY, JSON.stringify([...pending.filter((r) => r.device !== current.device), current]));
  }
  if (!window.__HANDSHAKE_PUSH__ && webPushSupported()) {
    await (await navigator.serviceWorker.ready).pushManager.getSubscription().then((s) => s?.unsubscribe()).catch(() => {});
  }
}

/// Tells relays to forget registrations this device let go of while they
/// couldn't be reached -- on every start, until each has heard.
export async function forgetPending(): Promise<void> {
  const pending = readStoredJson<Registration[]>(FORGETTING_KEY) ?? [];
  if (pending.length === 0) return;
  const left: Registration[] = [];
  for (const gone of pending) if (!(await forgetAt(gone))) left.push(gone);
  if (left.length > 0) store(FORGETTING_KEY, JSON.stringify(left));
  else forget(FORGETTING_KEY);
}

let refilling: Promise<void> | null = null;

/// Fetches a new batch of tokens -- or, if the relay has forgotten this
/// device, registers it again (`registerAgain`).
function refill(current: Registration) {
  refilling ??= post<Batch>(`${current.relay}/devices/tokens`, { device: current.device, secret: current.secret })
    .then((batch) => {
      const latest = registration();
      if (latest?.device === current.device) store(KEY, JSON.stringify({ ...latest, tokens: [...latest.tokens, ...held(batch)] }));
    })
    .catch((err: { status?: number }) => {
      if (err.status === 404 && registration()?.device === current.device) registerAgain();
    })
    .finally(() => (refilling = null));
}

/// The wake tokens an order carries: one for its store, and for a delivery
/// one for its driver.
export interface OrderWakeTokens {
  wake_for_store: string | null;
  wake_for_driver: string | null;
}

/// Takes `count` tokens from this device's pool, if it holds them.
function takeTokens(count: number): HeldToken[] | null {
  const current = registration();
  if (!current || current.relay !== relayUrl() || current.tokens.length < count) {
    if (current) refill(current);
    return null;
  }
  const taken = current.tokens.slice(0, count);
  const rest = current.tokens.slice(count);
  store(KEY, JSON.stringify({ ...current, tokens: rest }));
  if (rest.length < REFILL_BELOW) refill({ ...current, tokens: rest });
  return taken;
}

/// Puts tokens an order never used back in the pool -- still unseen by
/// anyone, so still this device's alone.
function giveBack(tokens: HeldToken[]): void {
  const current = registration();
  if (current) store(KEY, JSON.stringify({ ...current, tokens: [...tokens, ...current.tokens] }));
}

/// Places an order with wake tokens -- its store's, and for a delivery its
/// driver's too -- or none, when this device isn't set up to be woken. Each
/// token is used once: two orders' tokens don't look alike. One whose order
/// surely never made it onto the network (refused, or never sent) goes back
/// in the pool: a failed checkout spends none.
export async function withWakeTokens<T>(forDriver: boolean, place: (tokens: OrderWakeTokens) => Promise<T>, notWritten: (err: unknown) => boolean): Promise<T> {
  const taken = takeTokens(forDriver ? 2 : 1);
  const tokens: OrderWakeTokens = { wake_for_store: taken?.[0]?.token ?? null, wake_for_driver: forDriver ? (taken?.[1]?.token ?? null) : null };
  try {
    return await place(tokens);
  } catch (err) {
    if (taken && notWritten(err)) giveBack(taken);
    throw err;
  }
}

/// Wakes a customer whose order this store or driver just changed, with
/// the token their order gave us. Best-effort: they'll see it when they
/// next open the app regardless.
export function wakeCustomer(token: string): void {
  const relay = relayUrl();
  if (!relay) return;
  void fetch(`${relay}/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) }).catch(() => {});
}

/// Tells the service worker what to show when a wake arrives, in this
/// person's language -- now, and again whenever they change it. It has no
/// way to read the order, so it says only that something changed.
export function teachServiceWorker(): void {
  if (!webPushSupported()) return;
  const teach = () => {
    const words = { title: t("wake.title"), body: t("wake.body") };
    void navigator.serviceWorker.ready.then((worker) => worker.active?.postMessage({ type: "wake-words", ...words })).catch(() => {});
  };
  teach();
  useLocale.subscribe((now, before) => now.locale !== before.locale && teach());
}

function bytesFromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
