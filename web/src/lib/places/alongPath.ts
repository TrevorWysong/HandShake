// Following the road on a map: where a position falls along a drawn route,
// and the stretch of road between two of them -- so a driver's pin travels
// the streets between the positions they share, as the big apps' maps do,
// rather than cutting across blocks. Flat-earth maths over a few km: close
// enough to draw with, and used for nothing but drawing.
import type { GeoPoint } from "../../holochain/types";

/// How far off the route a position may be and still be put on it: GPS
/// drifts into buildings; a driver who's truly left the route isn't on it.
export const SNAP_KM = 0.05;

const KM_PER_DEGREE = 111.2;

/// Where a position falls on a path: how far along it and off it (km), and
/// the nearest point on it.
export interface OnPath {
  along: number;
  off: number;
  at: GeoPoint;
}

/// `p`'s place on `path`, if the path has a length.
export function locate(path: GeoPoint[], p: GeoPoint): OnPath | null {
  const scale = Math.cos((p.lat * Math.PI) / 180);
  // Kilometres east and north of `p`.
  const xy = (q: GeoPoint) => [(q.lon - p.lon) * scale * KM_PER_DEGREE, (q.lat - p.lat) * KM_PER_DEGREE];
  let best: OnPath | null = null;
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = xy(path[i - 1]);
    const [bx, by] = xy(path[i]);
    const [dx, dy] = [bx - ax, by - ay];
    const length = Math.hypot(dx, dy);
    const t = length === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length ** 2));
    const off = Math.hypot(ax + dx * t, ay + dy * t);
    const leg = lengthKm(path[i - 1], path[i]);
    if (!best || off < best.off) best = { along: walked + leg * t, off, at: between(path[i - 1], path[i], t) };
    walked += leg;
  }
  return best;
}

/// The way from `from` to `to` by `path`'s road, when both are on it and
/// `to` is further along; otherwise straight there -- off the route, or
/// turned back, the road drawn isn't the one they're on.
export function roadBetween(path: GeoPoint[] | null, from: GeoPoint, to: GeoPoint): GeoPoint[] {
  const start = path && locate(path, from);
  const end = path && locate(path, to);
  if (!path || !start || !end || end.off > SNAP_KM) return [from, to];
  if (start.off > SNAP_KM || end.along <= start.along) return [from, end.at];
  const way = [from, start.at];
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    walked += lengthKm(path[i - 1], path[i]);
    if (walked > start.along && walked < end.along) way.push(path[i]);
  }
  way.push(end.at);
  return way;
}

/// The point `fraction` of the way along `way`, by distance.
export function pointAlong(way: GeoPoint[], fraction: number): GeoPoint {
  const legs = way.slice(1).map((p, i) => lengthKm(way[i], p));
  let left = Math.min(1, Math.max(0, fraction)) * legs.reduce((sum, leg) => sum + leg, 0);
  for (const [i, leg] of legs.entries()) {
    if (left <= leg && leg > 0) return between(way[i], way[i + 1], left / leg);
    left -= leg;
  }
  return way[way.length - 1];
}

function lengthKm(a: GeoPoint, b: GeoPoint): number {
  const scale = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * scale, b.lat - a.lat) * KM_PER_DEGREE;
}

function between(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}
