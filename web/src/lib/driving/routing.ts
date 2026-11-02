// Travel times by road, from the network's routing service -- an
// OSRM-compatible API it chooses (its `services` setting): its own OSRM, or
// OpenStreetMap Germany's public one in development. `{profile}` in its URL
// picks the instance for how the driver gets around. Every request tells
// that server where someone is and is going, so a network serious about
// privacy runs its own. With none, or no answer, there's no estimate: a
// driver types their own ETA, and auto-bid passes the order by.
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

function baseUrl(mode: TravelMode): string | null {
  const url = networkServices().routing_url;
  return url ? url.replaceAll("{profile}", PROFILE[mode]).replace(/\/$/, "") : null;
}

const coordinates = (points: GeoPoint[]) => points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";");

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`routing: ${res.status}`);
  return res.json();
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
