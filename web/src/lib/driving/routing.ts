// Travel times by road, from the network's routing service -- an
// OSRM-compatible API it chooses (its `services` setting): its own OSRM, or
// OpenStreetMap Germany's public one in development. `{profile}` in its URL
// picks the instance for how the driver gets around. Every request tells
// that server roughly where someone is and is going -- each point rounded
// to about 100 m, sent only over https -- so a network serious about
// privacy runs its own. With none, or no answer, there's no estimate: a
// driver types their own ETA, and auto-bid passes the order by. A burst of
// orders can't turn into a burst of requests: a few at a time, each asked
// once in a while.
import type { GeoPoint } from "../../holochain/types";
import type { MessageKey } from "../../i18n";
import { networkServices } from "../../store/network";

/// How a driver gets around.
export type TravelMode = "car" | "scooter" | "bike" | "foot";

/// Each, as sign-up and the driver's settings name it.
export const TRAVEL_MODES: readonly { mode: TravelMode; label: MessageKey }[] = [
  { mode: "car", label: "onboarding.vehicle.car" },
  { mode: "scooter", label: "onboarding.vehicle.scooter" },
  { mode: "bike", label: "onboarding.vehicle.bike" },
  { mode: "foot", label: "onboarding.vehicle.foot" },
];

/// The routing profile for each: a scooter rides the roads a car does.
const PROFILE: Record<TravelMode, string> = { car: "car", scooter: "car", bike: "bike", foot: "foot" };

/// A slow answer is no answer: the driver can still type their ETA.
const TIMEOUT_MS = 8_000;
/// The most points one request carries -- the public servers' table limit.
const MAX_POINTS = 100;
/// A duration past this is a broken answer, not a trip across town.
const MAX_SECONDS = 12 * 3600;
/// Requests at once, and how long an answer's reused.
const MAX_IN_FLIGHT = 4;
const REUSE_MS = 5 * 60_000;
const MAX_REMEMBERED = 200;

/// The service for a way of travelling: https only, or a dev machine's own.
function baseUrl(mode: TravelMode): string | null {
  const url = networkServices().routing_url?.replaceAll("{profile}", PROFILE[mode]).replace(/\/$/, "");
  if (!url) return null;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || (protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1")) ? url : null;
  } catch {
    return null;
  }
}

// Three decimals: about 100 m -- enough for a drive time, and no closer.
const coordinates = (points: GeoPoint[]) => points.map((p) => `${p.lon.toFixed(3)},${p.lat.toFixed(3)}`).join(";");

let inFlight = 0;
const waiting: (() => void)[] = [];
const remembered = new Map<string, { at: number; answer: Promise<unknown> }>();

async function fetchJson(url: string): Promise<unknown> {
  // A finished request hands its place straight to the next waiting.
  if (inFlight < MAX_IN_FLIGHT) inFlight++;
  else await new Promise<void>((go) => waiting.push(go));
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error(`routing: ${res.status}`);
    return await res.json();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

/// The answer for `url`: the same request within a few minutes shares one;
/// a failed one isn't kept.
function getJson(url: string): Promise<unknown> {
  const now = Date.now();
  const kept = remembered.get(url);
  if (kept && now - kept.at < REUSE_MS) return kept.answer;
  const answer = fetchJson(url);
  remembered.delete(url);
  remembered.set(url, { at: now, answer });
  if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value!);
  answer.catch(() => remembered.get(url)?.answer === answer && remembered.delete(url));
  return answer;
}

/// Forgets every kept answer -- for tests.
export function forgetRoutes() {
  remembered.clear();
}

/// Minutes, from an answer's seconds -- or null for anything that isn't one.
function minutes(seconds: unknown): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_SECONDS ? seconds / 60 : null;
}

/// Minutes by road for each leg of a trip through `points`, in order -- or
/// null with no service or no route.
export async function legMinutes(mode: TravelMode, points: GeoPoint[]): Promise<number[] | null> {
  const base = baseUrl(mode);
  if (!base || points.length < 2 || points.length > MAX_POINTS) return null;
  try {
    const body = (await getJson(`${base}/route/v1/driving/${coordinates(points)}?overview=false&steps=false`)) as { code?: unknown; routes?: { legs?: { duration?: unknown }[] }[] };
    const legs = body.code === "Ok" ? body.routes?.[0]?.legs : undefined;
    if (!Array.isArray(legs) || legs.length !== points.length - 1) return null;
    const each = legs.map((leg) => minutes(leg?.duration));
    return each.every((m) => m !== null) ? (each as number[]) : null;
  } catch {
    return null;
  }
}

/// Minutes by car from each of `from` to `to` -- null for one it can't
/// route, or for all with no service.
export async function minutesTo(to: GeoPoint, from: GeoPoint[]): Promise<(number | null)[]> {
  const base = baseUrl("car");
  const none = from.map(() => null);
  if (!base || from.length === 0) return none;
  const chunks: GeoPoint[][] = [];
  for (let i = 0; i < from.length; i += MAX_POINTS - 1) chunks.push(from.slice(i, i + MAX_POINTS - 1));
  const answers = await Promise.all(
    chunks.map(async (chunk) => {
      const sources = chunk.map((_, i) => i + 1).join(";");
      try {
        const body = (await getJson(`${base}/table/v1/driving/${coordinates([to, ...chunk])}?sources=${sources}&destinations=0&annotations=duration`)) as { code?: unknown; durations?: unknown };
        const rows = body.code === "Ok" && Array.isArray(body.durations) && body.durations.length === chunk.length ? body.durations : null;
        return chunk.map((_, i) => (rows && Array.isArray(rows[i]) ? minutes(rows[i][0]) : null));
      } catch {
        return chunk.map(() => null);
      }
    }),
  );
  return answers.length ? answers.flat() : none;
}

/// The most points a route's line is drawn with: a long drive's full path
/// is thousands, and the map needs no more than this to follow its roads.
const MAX_PATH_POINTS = 2_000;

/// The way by road through `points`, in order, as a line to draw and how
/// long it takes -- or null with no service or no route. A car's route: the
/// customer's map doesn't know how the driver gets around.
export async function routePath(points: GeoPoint[]): Promise<{ path: GeoPoint[]; minutes: number } | null> {
  const base = baseUrl("car");
  if (!base || points.length < 2 || points.length > MAX_POINTS) return null;
  try {
    const body = (await getJson(`${base}/route/v1/driving/${coordinates(points)}?overview=full&geometries=geojson&steps=false`)) as { code?: unknown; routes?: { duration?: unknown; geometry?: { coordinates?: unknown } }[] };
    const route = body.code === "Ok" ? body.routes?.[0] : undefined;
    const took = minutes(route?.duration);
    const line = route?.geometry?.coordinates;
    if (took === null || !Array.isArray(line) || line.length < 2) return null;
    // An answer from elsewhere: only well-formed coordinates are drawn.
    const path: GeoPoint[] = [];
    const step = Math.ceil(line.length / MAX_PATH_POINTS);
    // Every `step`th point, and always the last: the line ends where it goes.
    for (let i = 0; i < line.length; i = i === line.length - 1 ? line.length : Math.min(i + step, line.length - 1)) {
      const [lon, lat] = Array.isArray(line[i]) ? line[i] : [];
      if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      path.push({ lat, lon });
    }
    return { path, minutes: took };
  } catch {
    return null;
  }
}
