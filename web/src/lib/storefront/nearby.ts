// Ranking the stores near someone from their listings alone -- before any
// store is read -- by where each listing says it is.
import { bytesToHex } from "../../holochain/decode";
import type { GeoPoint } from "../../holochain/types";
import type { NearbyListing } from "../../holochain/zomes/catalog";
import { distanceKm, geohashCenter } from "../places/geohash";

/// A store near someone, from its listing alone.
export interface Listing {
  hash: Uint8Array;
  hex: string;
  /// Where its listing says it is, to about 20 metres.
  point: GeoPoint;
}

/// The listings, nearest to `here` first. One whose position can't be read
/// is left out: validation never lets one be written.
export function nearestFirst(listings: NearbyListing[], here: GeoPoint): Listing[] {
  const found: (Listing & { km: number })[] = [];
  for (const listing of listings) {
    try {
      const point = geohashCenter(listing.geohash);
      found.push({ hash: listing.catalog, hex: bytesToHex(listing.catalog), point, km: distanceKm(here, point) });
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => a.km - b.km).map(({ hash, hex, point }) => ({ hash, hex, point }));
}

/// Every listing read so far, in the order they're shown: those in the cells
/// around someone, nearest first, then -- once the wider area's been read --
/// the rest of it, nearest first after them. Nothing shown moves for what
/// comes after it.
export function inTiers(near: Listing[], wider: Listing[] | undefined): Listing[] {
  if (!wider) return near;
  const shown = new Set(near.map((l) => l.hex));
  return [...near, ...wider.filter((l) => !shown.has(l.hex))];
}

/// `items` ordered a page of `size` at a time, each page on its own: reading
/// the next page never moves what's above it.
export function pageByPage<T>(items: T[], size: number, order: (page: T[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...order(items.slice(i, i + size)));
  return out;
}
