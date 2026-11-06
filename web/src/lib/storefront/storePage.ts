// What a storefront's two pages -- the menu and its info -- read.
import { getCatalog, listGoodieBagsForCatalog } from "../../holochain/zomes/catalog";
import { decodeEntry } from "../../holochain/decode";
import type { GoodieBag, MerchantCatalog } from "../../holochain/types";
import { nowMicros } from "../ui/format";
import type { BagRow } from "./bags";
import { fetchMenu, type ItemRow } from "./menu";

export interface StoreMenu {
  catalog: MerchantCatalog;
  items: ItemRow[];
  bags: BagRow[];
}

/// The menus read lately, so coming back from a store's info page shows its
/// menu at once, where it was left, while a fresh read replaces it. Menus are
/// public, and a few are enough for going back and forth.
const REMEMBERED = 8;
const remembered = new Map<string, StoreMenu>();

export function rememberedStoreMenu(hash: string): StoreMenu | undefined {
  return remembered.get(hash);
}

export async function fetchStoreMenu(hash: string, catalogHash: Uint8Array): Promise<StoreMenu> {
  const [record, items, bagViews] = await Promise.all([getCatalog(catalogHash), fetchMenu(catalogHash), listGoodieBagsForCatalog(catalogHash)]);
  // Same as Browse.tsx's strip: drops a bag that closed since the last poll.
  const now = nowMicros();
  const menu: StoreMenu = {
    catalog: decodeEntry<MerchantCatalog>(record),
    items,
    bags: bagViews.map((v) => ({ hash: v.original_action, bag: decodeEntry<GoodieBag>(v.record) })).filter((r) => r.bag.pickup_window_end > now),
  };
  remembered.delete(hash);
  remembered.set(hash, menu);
  if (remembered.size > REMEMBERED) remembered.delete(remembered.keys().next().value!);
  return menu;
}
