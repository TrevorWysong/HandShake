// Whether a store has a deal on: a promo code anyone could use, or an item on
// sale now. One promo read and its menu per store, so a list asks only once
// someone's looking for deals.
import { listLivePromoCodes } from "../../holochain/zomes/catalog";
import type { ActionHash, MerchantCatalog } from "../../holochain/types";
import { fetchMenu } from "./menu";
import { saleRunning } from "./sales";

export async function hasDeal(catalogRef: ActionHash, catalog: MerchantCatalog, at: Date): Promise<boolean> {
  const promos = await listLivePromoCodes(catalogRef).catch(() => []);
  if (promos.length > 0) return true;
  const menu = await fetchMenu(catalogRef).catch(() => []);
  return menu.some(({ item }) => item.available && !!item.sale && saleRunning(item.sale, catalog, at));
}
