// What the cart reads of the store it's ordering from, and works out from
// it: the store's terms and menu, the codes the customer can use, the best
// one that applies itself, and whether a drop-off is in range.
import { distanceKm } from "../../../lib/places/geohash";
import { type CartLine } from "../../../store/cart";
import { countMyCompletedOrders, myPromoStanding } from "../../../holochain/zomes/dispatch";
import { getCatalog, listLivePromoCodes } from "../../../holochain/zomes/catalog";
import { bytesEqual, decodeEntry } from "../../../holochain/decode";
import { formatDistance } from "../../../lib/ui/format";
import { t as translate } from "../../../i18n";
import { computePromoEffect, isPromoEligible } from "../../../lib/storefront/promotions";
import { fetchMenu, type ItemRow } from "../../../lib/storefront/menu";
import type { ActionHash, GeoPoint, MerchantCatalog, PromoCode, TaxRate, PromoStanding } from "../../../holochain/types";

// A pre-check, so the customer hears it while choosing: the network refuses
// an order outside the radius of the store version it cites. `null` for
// `merchantLocation`/`merchantRadiusKm` (catalog still loading) means
// nothing to check yet, so every pick is allowed rather than blocked on a
// fetch that hasn't resolved.
export function validateDropoffRadius(point: GeoPoint, merchantLocation: GeoPoint | null, merchantRadiusKm: number | null): string | null {
  if (!merchantLocation || merchantRadiusKm === null) return null;
  const distance = distanceKm(merchantLocation, point);
  if (distance > merchantRadiusKm) {
    return translate("cart.outOfRange", { distance: formatDistance(distance), radius: formatDistance(merchantRadiusKm) });
  }
  return null;
}

export type PromoRow = { hash: ActionHash; promo: PromoCode; standing?: PromoStanding };
export const NO_PROMOS: PromoRow[] = [];
export const NO_ITEMS: ItemRow[] = [];

export interface CartStoreInfo {
  subsidyPercent: number;
  // The store's delivery range -- lets `onValidate` below reject an
  // out-of-range drop-off as it's picked (the network refuses one anyway).
  // `null` until the catalog loads: nothing to check yet.
  merchantLocation: GeoPoint | null;
  merchantRadiusKm: number | null;
  /// When the store takes orders -- checkout says so up front; the zome
  /// refuses a closed store regardless. `null` until the catalog loads.
  hours: Pick<MerchantCatalog, "is_open" | "weekly_hours" | "time_zone"> | null;
  /// The most an order may cost to be left at the door, if the store sets
  /// a limit -- above it, the option isn't offered.
  leaveAtDoorMaxCents: number | null;
  /// The smallest order the store takes, before promos -- the network
  /// refuses a smaller one.
  minOrderCents: number | null;
  /// Minutes the store is adding to its prep time while it's busy.
  busyExtraMinutes: number;
  /// How long past the ready time the store may keep a driver waiting, if
  /// it sets its own -- else the network's.
  storeWaitMinutes: number | null;
  /// The store's sales tax or VAT -- its own, on its own terms.
  taxRates: TaxRate[];
  pricesIncludeTax: boolean;
  promoCodes: PromoRow[];
  menuItems: ItemRow[];
  completedOrderCount: number;
}

/// Everything the cart needs about the store it's ordering from, read
/// once per store. Each part degrades independently on failure, same as
/// before -- a missing promo list shouldn't block checkout.
export async function fetchCartStoreInfo(catalogRef: ActionHash): Promise<CartStoreInfo> {
  const [catalog, livePromos, menuItems, completedOrderCount, standings] = await Promise.all([
    getCatalog(catalogRef)
      .then((record) => decodeEntry<MerchantCatalog>(record))
      .catch(() => null),
    // Only codes usable right now -- the store's live index, not every
    // code it ever ran.
    listLivePromoCodes(catalogRef)
      .then((views) => views.map((v) => ({ hash: v.original_action, promo: decodeEntry<PromoCode>(v.record) })))
      .catch(() => []),
    // Needed to describe/evaluate item-scoped requirements and rewards
    // (BOGO, "spend $X get item Y free") even when the item they name isn't
    // already sitting in the cart.
    fetchMenu(catalogRef)
      .catch(() => []),
    // Loyalty rewards ("order 5 times, your 6th is discounted") count this
    // customer's completed orders at *this* store, delivery and pickup.
    countMyCompletedOrders(catalogRef).catch(() => 0),
    // Where the customer stands with each code: used up, once a day...
    myPromoStanding(catalogRef).catch(() => [] as PromoStanding[]),
  ]);
  const promoCodes = livePromos.map((row) => ({ ...row, standing: standings.find((s) => bytesEqual(s.promo, row.hash)) }));
  return {
    subsidyPercent: catalog?.delivery_subsidy_percent ?? 0,
    merchantLocation: catalog?.location ?? null,
    merchantRadiusKm: catalog?.max_delivery_radius_km ?? null,
    hours: catalog,
    leaveAtDoorMaxCents: catalog?.leave_at_door_max_cents ?? null,
    minOrderCents: catalog?.min_order_cents ?? null,
    busyExtraMinutes: catalog?.busy_extra_minutes ?? 0,
    storeWaitMinutes: catalog?.store_wait_minutes ?? null,
    taxRates: catalog?.tax_rates ?? [],
    pricesIncludeTax: catalog?.prices_include_tax ?? false,
    promoCodes,
    menuItems,
    completedOrderCount,
  };
}

/// The best auto-apply promo eligible for this cart at `now` (microseconds),
/// or `null`.
export function bestAutoApplyPromo(promoCodes: PromoRow[], lines: CartLine[], total: number, completedOrderCount: number, now: number): PromoRow | null {
  const eligible = promoCodes.filter(
    (p) =>
      p.promo.auto_apply &&
      p.promo.active &&
      !p.standing?.blocked &&
      (p.promo.expires_at === null || p.promo.expires_at > now) &&
      isPromoEligible(p.promo.requirement, lines, total, completedOrderCount),
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((a, b) =>
    computePromoEffect(b.promo.reward, lines, total).subtotalDiscountCents > computePromoEffect(a.promo.reward, lines, total).subtotalDiscountCents ? b : a,
  );
}
