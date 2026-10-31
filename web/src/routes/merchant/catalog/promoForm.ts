import { hexToBytes } from "../../../holochain/decode";
import type { PromoLimits, PromoPeriod, PromoRequirement, PromoReward } from "../../../holochain/types";
import { toMinorUnits } from "../../../lib/ui/format";

// Requirement and reward are picked independently (two dropdowns), the
// same way `PromoRequirement`/`PromoReward` are two independent enums in
// Rust: a plain code, "spend $X get item Y free" and BOGO are each just one
// requirement paired with one reward -- never a hard-coded "promo type".
export type RequirementKind = "none" | "minSpend" | "minItemQty" | "loyalty";
export type RewardKind = "percentOffSubtotal" | "flatOffSubtotal" | "freeItem" | "percentOffItem";

export const EMPTY_PROMO_FORM = {
  code: "",
  requirementKind: "none" as RequirementKind,
  /// Dollars (minSpend), units (minItemQty), or prior orders (loyalty).
  requirementAmount: 20,
  requirementItemHex: "",
  rewardKind: "percentOffSubtotal" as RewardKind,
  /// Percent (percentOff*) or dollars (flatOffSubtotal).
  rewardAmount: 10,
  rewardItemHex: "",
  rewardQuantity: 1,
  autoApply: false,
  /// Who may use it, and how often.
  firstOrderOnly: false,
  /// "any", "once", or a number of uses per customer.
  perCustomer: "any" as "any" | "once" | "custom",
  perCustomerCount: 3,
  oncePer: "any" as "any" | PromoPeriod,
  totalLimited: false,
  total: 100,
};

export type PromoForm = typeof EMPTY_PROMO_FORM;

/// The form's limits, as the network takes them.
export function buildLimits(form: PromoForm): PromoLimits {
  return {
    first_order_only: form.firstOrderOnly,
    per_customer: form.perCustomer === "once" ? 1 : form.perCustomer === "custom" ? Math.min(1000, Math.max(1, Math.round(form.perCustomerCount))) : null,
    once_per: form.oncePer === "any" ? null : form.oncePer,
    total: form.totalLimited ? Math.min(1_000_000, Math.max(1, Math.round(form.total))) : null,
  };
}

/// `null` while the form is incomplete (an item-scoped kind with no item).
export function buildRequirement(form: PromoForm): PromoRequirement | null {
  switch (form.requirementKind) {
    case "none":
      return "None";
    case "minSpend":
      return { MinimumSpend: Math.max(1, toMinorUnits(form.requirementAmount)) };
    case "minItemQty":
      if (!form.requirementItemHex) return null;
      return { MinimumItemQuantity: { item_ref: hexToBytes(form.requirementItemHex), quantity: Math.max(1, Math.round(form.requirementAmount)) } };
    case "loyalty":
      return { LoyaltyOrderCount: Math.max(1, Math.round(form.requirementAmount)) };
  }
}

/// `null` while the form is incomplete (an item-scoped kind with no item).
export function buildReward(form: PromoForm): PromoReward | null {
  const percent = Math.min(100, Math.max(1, Math.round(form.rewardAmount)));
  const quantity = Math.max(1, Math.round(form.rewardQuantity));
  switch (form.rewardKind) {
    case "percentOffSubtotal":
      return { PercentOffSubtotal: percent };
    case "flatOffSubtotal":
      return { FlatOffSubtotal: Math.max(1, toMinorUnits(form.rewardAmount)) };
    case "freeItem":
      if (!form.rewardItemHex) return null;
      return { FreeItem: { item_ref: hexToBytes(form.rewardItemHex), quantity } };
    case "percentOffItem":
      if (!form.rewardItemHex) return null;
      return { PercentOffItem: { item_ref: hexToBytes(form.rewardItemHex), percent, quantity } };
  }
}
