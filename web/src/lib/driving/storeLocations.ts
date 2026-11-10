// Where stores are, for what a driver's offered: read from their public
// records, a batch at a time, and kept while the app runs -- a store rarely
// moves, and a feed that reads every few seconds shouldn't read them again.
import { getListedStores, STORE_BATCH } from "../../holochain/zomes/catalog";
import { bytesToHex, decodeEntry } from "../../holochain/decode";
import type { ActionHash, GeoPoint, MerchantCatalog } from "../../holochain/types";

/// The most stores kept: past it, the longest-kept go first.
const MAX_KEPT = 500;

/// By store (its original action, hex): where it is, or null for one that
/// couldn't be read (moved, or gone).
const kept = new Map<string, GeoPoint | null>();

/// Where each of `stores` is, by hex -- those that can be read.
export async function storeLocations(stores: ActionHash[]): Promise<Map<string, GeoPoint>> {
  const byHex = new Map(stores.map((store) => [bytesToHex(store), store] as const));
  const missing = [...byHex].filter(([hex]) => !kept.has(hex)).map(([, store]) => store);
  for (let i = 0; i < missing.length; i += STORE_BATCH) {
    const batch = missing.slice(i, i + STORE_BATCH);
    const read = await getListedStores(batch).catch(() => null);
    if (!read) continue;
    const found = new Map(read.map((store) => [bytesToHex(store.original_action), decodeEntry<MerchantCatalog>(store.record).location] as const));
    for (const store of batch) remember(bytesToHex(store), found.get(bytesToHex(store)) ?? null);
  }
  const located = new Map<string, GeoPoint>();
  for (const hex of byHex.keys()) {
    const at = kept.get(hex);
    if (at) located.set(hex, at);
  }
  return located;
}

function remember(hex: string, at: GeoPoint | null): void {
  kept.delete(hex);
  kept.set(hex, at);
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
}
