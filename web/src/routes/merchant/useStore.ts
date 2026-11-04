// The store a per-store page is about, read once for every section on it
// (`ActiveStore.tsx` picks which).
import { getCatalog, listModifierGroups } from "../../holochain/zomes/catalog";
import { decodeEntry, hexToBytes } from "../../holochain/decode";
import { useResource } from "../../lib/hooks/useResource";
import { fetchMenu } from "../../lib/storefront/menu";
import type { GroupRow } from "./catalog/ChoicesSection";
import type { MerchantCatalog, ModifierGroup } from "../../holochain/types";

/// The store's profile and its whole menu, with its choice groups -- read
/// once for every section that needs them (the promo form picks items from
/// the menu).
async function fetchStore(catalogRef: Uint8Array) {
  const [record, items, groupViews] = await Promise.all([getCatalog(catalogRef), fetchMenu(catalogRef), listModifierGroups(catalogRef)]);
  const groups: GroupRow[] = groupViews.map((v) => ({ hash: v.original_action, group: decodeEntry<ModifierGroup>(v.record) }));
  return { catalog: decodeEntry<MerchantCatalog>(record), items, groups };
}

/// The store `storeHex` names, as `fetchStore` reads it.
export function useStore(storeHex: string) {
  const catalogRef = hexToBytes(storeHex);
  const { data, reload } = useResource(`store:${storeHex}`, () => fetchStore(catalogRef));
  return { catalogRef, data, reload };
}
