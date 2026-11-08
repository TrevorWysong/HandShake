// Generic promo-code evaluation, mirroring the Rust side's
// `PromoRequirement`/`PromoReward` split (itself grounded in how DoorDash's
// own Promotion Management API separates `purchase_criteria` from
// `discount_options`). A plain percent/flat-off code, a "spend $X get item Y free"
// deal, and a buy-X-get-Y-free (BOGO) deal are all just one requirement
// variant paired with one reward variant -- nothing here branches on "which
// promo type is this," so a new requirement or reward shape later is a new
// `case`/`in` arm in exactly one place (here), not a new code path threaded
// through Cart.tsx or the merchant catalog UI.
import { lineKey, type CartLine } from "../../store/cart";
import type { ActionHash, ChoiceTerms, PromoBlock, PromoCode, PromoLimits, PromoRequirement, PromoReward, PromoStanding } from "../../holochain/types";
import { bytesToHex } from "../../holochain/decode";
import { formatCents } from "../ui/format";
import { appLocale, t } from "../../i18n";

/// The cart's lines of `itemRef` -- the same item may be on several, with
/// different choices.
function linesOf(lines: CartLine[], itemRef: ActionHash): CartLine[] {
  const key = bytesToHex(itemRef);
  return lines.filter((l) => bytesToHex(l.itemRef) === key);
}

/// What an item reward with `terms` pays for in one unit of `line` -- the
/// item, and the chosen units the terms include, the dearest first -- or
/// `null` if its choices fall outside them (`catalog_types::pricing`).
export function covered(line: Pick<CartLine, "basePriceCents" | "priceCents" | "choiceCharges">, terms: ChoiceTerms[]): number | null {
  let cents = line.basePriceCents;
  for (const term of terms) {
    const group = line.choiceCharges.find((g) => g.group === bytesToHex(term.group));
    if (!group) return null;
    if (term.options.length > 0 && group.units.some((u) => !term.options.includes(u.option))) return null;
    const charges = group.units.map((u) => u.cents).sort((a, b) => b - a);
    cents += charges.slice(0, term.included).reduce((sum, c) => sum + c, 0);
  }
  return Math.min(cents, line.priceCents);
}

/// Up to `quantity` units of `itemRef` within `terms`, taken from its lines
/// in order, each discounted `perUnit` of what the terms cover -- an item
/// promo takes off the item and the choices it names, the rest still
/// charged.
function itemDiscount(lines: CartLine[], itemRef: ActionHash, terms: ChoiceTerms[], quantity: number, perUnit: (covered: number) => number): PromoEffect {
  let left = quantity;
  const itemEffects: PromoItemEffect[] = [];
  for (const line of linesOf(lines, itemRef)) {
    const cents = covered(line, terms);
    if (cents === null) continue;
    const units = Math.min(left, line.quantity);
    if (units > 0) itemEffects.push({ lineKey: lineKey(line), quantity: units, discountCentsPerUnit: perUnit(cents) });
    left -= units;
  }
  return { subtotalDiscountCents: itemEffects.reduce((sum, e) => sum + e.quantity * e.discountCentsPerUnit, 0), itemEffects };
}

/// `completedOrderCount` is only meaningful for `LoyaltyOrderCount` --
/// optional and defaulted to 0 so every other requirement variant's
/// existing callers (which have no reason to know this) don't need to
/// change. Counting "how many times has this customer ordered here" is
/// the same client-side/best-effort trust tier as every other promo's
/// arithmetic -- see `PromoRequirement::LoyaltyOrderCount`'s own Rust doc
/// comment.
export function isPromoEligible(requirement: PromoRequirement, lines: CartLine[], subtotalCents: number, completedOrderCount = 0): boolean {
  if (requirement === "None") return true;
  if ("MinimumSpend" in requirement) return subtotalCents >= requirement.MinimumSpend;
  if ("MinimumItemQuantity" in requirement) {
    const { item_ref, quantity } = requirement.MinimumItemQuantity;
    return linesOf(lines, item_ref).reduce((n, l) => n + l.quantity, 0) >= quantity;
  }
  if ("LoyaltyOrderCount" in requirement) return completedOrderCount >= requirement.LoyaltyOrderCount;
  return false;
}

/// One line-item effect: `quantity` units of the cart line keyed `lineKey`
/// each get `discountCentsPerUnit` knocked off (the whole item when that
/// equals its base price).
export interface PromoItemEffect {
  lineKey: string;
  quantity: number;
  discountCentsPerUnit: number;
}

export interface PromoEffect {
  /// A flat discount applied to the whole subtotal -- 0 for item-scoped rewards.
  subtotalDiscountCents: number;
  /// Item-scoped discounts -- empty for whole-subtotal rewards.
  itemEffects: PromoItemEffect[];
}

const NO_EFFECT: PromoEffect = { subtotalDiscountCents: 0, itemEffects: [] };

export function computePromoEffect(reward: PromoReward, lines: CartLine[], subtotalCents: number): PromoEffect {
  if ("PercentOffSubtotal" in reward) {
    return { subtotalDiscountCents: Math.floor((subtotalCents * reward.PercentOffSubtotal) / 100), itemEffects: [] };
  }
  if ("FlatOffSubtotal" in reward) {
    return { subtotalDiscountCents: Math.min(reward.FlatOffSubtotal, subtotalCents), itemEffects: [] };
  }
  if ("FreeItem" in reward) {
    const { item_ref, quantity, choices } = reward.FreeItem;
    return itemDiscount(lines, item_ref, choices, quantity, (cents) => cents);
  }
  if ("PercentOffItem" in reward) {
    const { item_ref, percent, quantity, choices } = reward.PercentOffItem;
    return itemDiscount(lines, item_ref, choices, quantity, (cents) => Math.floor((cents * percent) / 100));
  }
  return NO_EFFECT;
}

export interface PromoEvaluation {
  eligible: boolean;
  effect: PromoEffect;
}

/// The one entry point callers actually need: is this cart eligible, and if
/// so, what does it save. Ineligible carts get a zeroed effect rather than
/// whatever `computePromoEffect` would compute against a cart that hasn't
/// actually earned the reward.
export function evaluatePromo(promo: PromoCode, lines: CartLine[], subtotalCents: number, completedOrderCount = 0): PromoEvaluation {
  const eligible = isPromoEligible(promo.requirement, lines, subtotalCents, completedOrderCount);
  return { eligible, effect: eligible ? computePromoEffect(promo.reward, lines, subtotalCents) : NO_EFFECT };
}

/// Human-readable summaries for both merchant management UI and customer
/// redemption UI, so neither has to hand-write per-variant copy. `itemName`
/// resolves an item_ref (hex) to a display name -- callers already have a
/// menu loaded for their own purposes (merchant catalog editing, customer
/// browsing), so this takes a lookup rather than fetching anything itself.
export function describeRequirement(requirement: PromoRequirement, itemName: (hex: string) => string | undefined): string {
  if (requirement === "None") return t("promo.req.none");
  if ("MinimumSpend" in requirement) return t("promo.req.spend", { amount: formatCents(requirement.MinimumSpend) });
  if ("MinimumItemQuantity" in requirement) {
    const { item_ref, quantity } = requirement.MinimumItemQuantity;
    return t("promo.req.buy", { quantity, item: itemName(bytesToHex(item_ref)) ?? t("promo.qualifyingItem") });
  }
  if ("LoyaltyOrderCount" in requirement) return t("promo.req.loyalty", { count: requirement.LoyaltyOrderCount });
  return t("promo.req.unknown");
}

export function describeReward(reward: PromoReward, itemName: (hex: string) => string | undefined): string {
  if ("PercentOffSubtotal" in reward) return t("promo.reward.percentOrder", { percent: reward.PercentOffSubtotal });
  if ("FlatOffSubtotal" in reward) return t("promo.reward.flatOrder", { amount: formatCents(reward.FlatOffSubtotal) });
  if ("FreeItem" in reward) {
    const { item_ref, quantity, choices } = reward.FreeItem;
    return withChoices(t("promo.reward.free", { count: quantity, item: itemName(bytesToHex(item_ref)) ?? t("promo.item") }), choices);
  }
  if ("PercentOffItem" in reward) {
    const { item_ref, percent, quantity, choices } = reward.PercentOffItem;
    return withChoices(t("promo.reward.percentItem", { percent, count: quantity, item: itemName(bytesToHex(item_ref)) ?? t("promo.item") }), choices);
  }
  return t("promo.reward.unknown");
}

const withChoices = (text: string, choices: ChoiceTerms[]) => (choices.length > 0 ? t("promo.reward.someChoices", { reward: text }) : text);

/// A promo's terms, as short chips: who it's for, how often, until when,
/// how many are left.
export function describeLimits(promo: PromoCode, standing?: PromoStanding): string[] {
  const limits: PromoLimits = promo.limits;
  const chips: string[] = [];
  if (limits.first_order_only) chips.push(t("deals.chip.new"));
  if (limits.per_customer === 1) chips.push(t("deals.chip.once"));
  else if (limits.per_customer) chips.push(t("deals.chip.uses", { count: limits.per_customer }));
  if (limits.once_per) chips.push(t(`deals.chip.per.${limits.once_per}`));
  if (promo.expires_at) chips.push(t("deals.chip.ends", { date: new Date(promo.expires_at / 1000).toLocaleDateString(appLocale(), { month: "short", day: "numeric" }) }));
  if (standing?.remaining != null && standing.remaining > 0 && standing.remaining <= 50) chips.push(t("deals.chip.left", { count: standing.remaining }));
  return chips;
}

/// Whether a code is out of reach for good -- used up, sold out, or for
/// newcomers they no longer are -- rather than for now (again tomorrow).
export const blockedForGood = (block: PromoBlock | null | undefined) => block === "UsedUp" || block === "SoldOut" || block === "FirstOrderOnly";

/// Why a customer can't use a promo now, in words.
export function describeBlock(block: PromoBlock): string {
  if (block === "FirstOrderOnly") return t("deals.block.first");
  if (block === "UsedUp") return t("deals.block.used");
  if (block === "SoldOut") return t("deals.block.soldOut");
  return t(`deals.block.again.${block.ThisPeriod}`);
}
