// How much of a delivery fee a store covers: a base share, and larger ones
// for larger orders -- "free delivery on orders $25+" is one tier of 100%.
// The same rules as `catalog_types::share`, which validation enforces (an
// order's share must be its store's for an order its size); the same cases
// run in web/test/deliveryShare.test.ts and the Rust tests.
import { MAX_SUBSIDY_TIERS, type MerchantCatalog, type SubsidyTier } from "../../holochain/types";
import { formatCents } from "../ui/format";
import { t } from "../../i18n";

export interface DeliveryShare {
  /// The share on every order, 0-100.
  base: number;
  /// Larger shares from an order size up, smallest first.
  tiers: readonly SubsidyTier[];
}

export const NO_SHARE: DeliveryShare = { base: 0, tiers: [] };

export function deliveryShareOf(store: Pick<MerchantCatalog, "delivery_subsidy_percent" | "delivery_subsidy_tiers"> | null | undefined): DeliveryShare {
  return store ? { base: store.delivery_subsidy_percent, tiers: store.delivery_subsidy_tiers } : NO_SHARE;
}

/// The share covered on an order whose food comes to `basis` -- after any
/// discount, before tax is added (`catalog_types::fee_basis`).
export function shareAt(share: DeliveryShare, basis: number): number {
  for (let i = share.tiers.length - 1; i >= 0; i--) if (basis >= share.tiers[i].from_cents) return share.tiers[i].percent;
  return share.base;
}

/// The next larger share an order of `basis` could reach, and how much
/// more food reaches it -- `null` at the top.
export function nextShare(share: DeliveryShare, basis: number): { percent: number; fromCents: number; moreCents: number } | null {
  const next = share.tiers.find((tier) => tier.from_cents > basis);
  return next ? { percent: next.percent, fromCents: next.from_cents, moreCents: next.from_cents - basis } : null;
}

/// What's wrong with a share, if anything -- validation's rules: every
/// share 0-100, at most `MAX_SUBSIDY_TIERS` tiers, each for a larger order
/// than the last and covering more.
export type ShareProblem = "range" | "tooMany" | "order";
export function shareProblem(share: DeliveryShare): ShareProblem | null {
  if (share.base < 0 || share.base > 100 || !Number.isInteger(share.base)) return "range";
  if (share.tiers.length > MAX_SUBSIDY_TIERS) return "tooMany";
  let last = { from: 0, percent: share.base };
  for (const tier of share.tiers) {
    if (tier.percent > 100 || !Number.isInteger(tier.percent) || !Number.isInteger(tier.from_cents)) return "range";
    if (tier.from_cents <= last.from || tier.percent <= last.percent) return "order";
    last = { from: tier.from_cents, percent: tier.percent };
  }
  return null;
}

/// What a share offers customers, as deals: free delivery on every order,
/// or from an order size up, or a part of the fee off from one.
export function deliveryDeals(share: DeliveryShare): { key: string; headline: string; terms: string }[] {
  const deals = share.base === 100 ? [{ key: "base", headline: t("deals.share.free"), terms: t("deals.share.always") }] : [];
  for (const tier of share.tiers) {
    deals.push({ key: `tier-${tier.from_cents}`, headline: tier.percent === 100 ? t("deals.share.free") : t("deals.share.percent", { percent: tier.percent }), terms: t("deals.share.from", { amount: formatCents(tier.from_cents) }) });
  }
  return deals;
}
