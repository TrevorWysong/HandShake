// The stores near someone, as Browse shows them. Every store near them is
// found from one cheap read of the listings (`getNearbyListings`), ranked
// nearest first by where each listing says its store is -- which the
// network holds to the store's own location. A store's record, goodie bags,
// rating and drive time are read only once it's shown, a batch at a time,
// and kept for the session: scrolling on reads the next stores, and coming
// back to Browse reads none again until they're due a refresh -- and finds
// the list as far down as it was left.
import { create } from "zustand";
import { getListedStores, STORE_BATCH } from "../holochain/zomes/catalog";
import type { Listing } from "../lib/storefront/nearby";
import { averageRating, getRatingSummary } from "../holochain/zomes/reputation";
import { bytesToHex, decodeEntry } from "../holochain/decode";
import type { GeoPoint, GoodieBag, MerchantCatalog } from "../holochain/types";
import { minutesTo } from "../lib/driving/routing";
import { hasDeal } from "../lib/storefront/storeDeals";

export interface BagRow {
  hash: Uint8Array;
  bag: GoodieBag;
}

/// A store as read, for its card.
export interface NearbyStore {
  hash: Uint8Array;
  hex: string;
  catalog: MerchantCatalog;
  bags: BagRow[];
  rating: number;
  reviewCount: number;
  /// When it was read, in milliseconds: it's read again once it's older than
  /// `FRESH_MS`.
  readAt: number;
}

/// How long a store's card stays as read before it's read again: menus,
/// hours and ratings change rarely, and a store's own page reads it fresh.
const FRESH_MS = 5 * 60_000;

/// How far down Browse has read around one place: how many pages, and
/// whether past the cells around it into the wider area.
export interface Paging {
  pages: number;
  wide: boolean;
}
export const FIRST_PAGE: Paging = { pages: 1, wide: false };

/// Where `here` is, as a key for drive times from it.
const placeKey = (here: GeoPoint) => `${here.lat.toFixed(5)},${here.lon.toFixed(5)}`;

interface NearbyStoresState {
  stores: Record<string, NearbyStore>;
  /// Listings whose store wasn't there to read (moved, or gone), and when.
  gone: Record<string, number>;
  /// Drive minutes to `here` from each store, by `placeKey(here)` then store.
  minutes: Record<string, Record<string, number | null>>;
  /// Whether each store has a deal on, and when that was asked -- only while
  /// someone's looking for deals.
  deals: Record<string, { deal: boolean; at: number }>;
  /// How far down Browse has read, by the place's geohash.
  paging: Record<string, Paging>;
  setPaging: (geohash: string, paging: Paging) => void;
  /// Brings `listings` up to date: reads each store not yet read, or due a
  /// refresh, and the drive time to `here` from each store that lacks one --
  /// and, `withDeals`, whether each has a deal on.
  read: (listings: Listing[], here: GeoPoint, withDeals: boolean) => Promise<void>;
}

/// Stores being read right now, so overlapping reads never ask twice.
const reading = new Set<string>();

export const useNearbyStores = create<NearbyStoresState>((set, get) => ({
  stores: {},
  gone: {},
  minutes: {},
  deals: {},
  paging: {},
  setPaging: (geohash, paging) => set((s) => ({ paging: { ...s.paging, [geohash]: paging } })),
  read: async (listings, here, withDeals) => {
    const due = Date.now() - FRESH_MS;
    const readAt = (hex: string) => get().stores[hex]?.readAt ?? get().gone[hex] ?? 0;
    const stale = listings.filter((l) => !reading.has(l.hex) && !(readAt(l.hex) > due));
    stale.forEach((l) => reading.add(l.hex));
    try {
      for (let i = 0; i < stale.length; i += STORE_BATCH) {
        const batch = stale.slice(i, i + STORE_BATCH);
        const listed = await getListedStores(batch.map((l) => l.hash));
        const read = await Promise.all(
          listed.map(async (view): Promise<NearbyStore> => {
            // This store's own rating only, never its owner's other stores
            // or their driving (see `reputation_integrity`'s module doc).
            const summary = await getRatingSummary({ Store: view.original_action }).catch(() => ({ count: 0, rating_sum: 0, uncounted: 0 }));
            return {
              hash: view.original_action,
              hex: bytesToHex(view.original_action),
              catalog: decodeEntry<MerchantCatalog>(view.record),
              bags: view.bags.map((b) => ({ hash: b.original_action, bag: decodeEntry<GoodieBag>(b.record) })),
              rating: averageRating(summary) ?? 0,
              reviewCount: summary.count,
              readAt: Date.now(),
            };
          }),
        );
        // A store no longer there (moved, or gone) drops out.
        set((s) => {
          const stores = { ...s.stores };
          const gone = { ...s.gone };
          for (const l of batch) {
            delete stores[l.hex];
            gone[l.hex] = Date.now();
          }
          for (const store of read) {
            stores[store.hex] = store;
            delete gone[store.hex];
          }
          return { stores, gone };
        });
      }
    } finally {
      stale.forEach((l) => reading.delete(l.hex));
    }

    const shown = listings.map((l) => get().stores[l.hex]).filter((s): s is NearbyStore => !!s);
    const place = placeKey(here);
    const untimed = shown.filter((s) => !(s.hex in (get().minutes[place] ?? {})));
    if (untimed.length > 0) {
      const minutes = await minutesTo(here, untimed.map((s) => s.catalog.location));
      set((s) => ({ minutes: { ...s.minutes, [place]: { ...s.minutes[place], ...Object.fromEntries(untimed.map((store, i) => [store.hex, minutes[i]])) } } }));
    }
    if (withDeals) {
      const unasked = shown.filter((s) => !((get().deals[s.hex]?.at ?? 0) > due));
      const at = new Date();
      const found = await Promise.all(unasked.map(async (s) => [s.hex, { deal: await hasDeal(s.hash, s.catalog, at), at: at.getTime() }] as const));
      set((s) => ({ deals: { ...s.deals, ...Object.fromEntries(found) } }));
    }
  },
}));

/// The drive minutes to `here` this session has, by store.
export const minutesFrom = (state: NearbyStoresState, here: GeoPoint) => state.minutes[placeKey(here)];
