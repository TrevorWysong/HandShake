// The one discount an order may carry (the network allows one): a reward
// redeemed into the bag, or else a promo code -- one the customer typed, a
// deal chosen on the store's page, or the best code that applies itself.
// Each is re-checked against the live cart every render, so adding or
// removing items changes what applies, and what it takes off.
import { useMemo, useState } from "react";
import { menuLines, useCart } from "../../../store/cart";
import { myCard } from "../../../holochain/zomes/rewards";
import { bytesToHex, hexToBytes } from "../../../holochain/decode";
import { describeBlock, describeRequirement, evaluatePromo, isPromoEligible } from "../../../lib/storefront/promotions";
import { itemNamer } from "../../../lib/storefront/menu";
import { rewardDiscount } from "../../../lib/rewards/rewards";
import { useRewardChooser } from "../../../components/rewards/useRewardChooser";
import { useResource } from "../../../lib/hooks/useResource";
import { nowMicros } from "../../../lib/ui/format";
import { useT } from "../../../i18n";
import type { Reward } from "../../../holochain/types";
import { bestAutoApplyPromo, NO_ITEMS, NO_PROMOS, type CartStoreInfo, type PromoRow } from "./checkout";

export function useDiscounts(storeInfo: CartStoreInfo | undefined, now: Date) {
  const t = useT();
  const cart = useCart();
  const promoCodes = storeInfo?.promoCodes ?? NO_PROMOS;
  const menuItems = storeInfo?.menuItems ?? NO_ITEMS;
  const completedOrderCount = storeInfo?.completedOrderCount ?? 0;
  const itemName = itemNamer(menuItems);
  // Promos and rewards are the menu's: goodie bags are already discounted.
  const lines = useMemo(() => menuLines(cart.lines), [cart.lines]);
  const subtotal = lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);

  // The store's rewards program, and the reward in the bag as it offers it
  // now: a reward takes the place of any promo.
  const catalogHex = cart.catalogRef ? bytesToHex(cart.catalogRef) : null;
  const { data: rewardsCard } = useResource(catalogHex ? `rewards:card:${catalogHex}` : null, () => myCard(hexToBytes(catalogHex!)));
  const rewardsProgram = rewardsCard?.program?.program.active ? rewardsCard.program.program : null;
  const chosenReward = (cart.reward && rewardsProgram?.rewards.find((r) => r.id === cart.reward!.id)) || null;

  /// Puts a reward in the bag -- or takes it out, tapped again. A free item
  /// with choices is chosen first (`rewardSheet`).
  const chooser = useRewardChooser(cart.catalogRef, menuItems, (reward, line) => cart.redeem(cart.catalogRef!, cart.merchant!, cart.merchantName ?? "", { id: reward.id, name: reward.name, cost: reward.cost }, line));
  const toggleReward = (reward: Reward) => (chosenReward?.id === reward.id ? cart.releaseReward() : chooser.redeem(reward));

  // A code the customer typed wins; then a deal chosen on the store's page,
  // if it's theirs to use; then the best code that applies itself --
  // re-chosen as the cart and the clock move, so one expiring while the
  // cart is open stops applying then. Removing a self-applied code turns
  // that off for this visit.
  const [promoInput, setPromoInput] = useState("");
  const [promoError, setPromoError] = useState<string | null>(null);
  const [manualPromo, setManualPromo] = useState<PromoRow | null>(null);
  const [autoPromoDismissed, setAutoPromoDismissed] = useState(false);
  const nowUs = now.getTime() * 1000;
  const autoPromo = useMemo(
    () => (autoPromoDismissed ? null : bestAutoApplyPromo(promoCodes, lines, subtotal, completedOrderCount, nowUs)),
    [autoPromoDismissed, promoCodes, lines, subtotal, completedOrderCount, nowUs],
  );
  const dealPromo = promoCodes.find((p) => cart.promoHex === bytesToHex(p.hash) && !p.standing?.blocked) ?? null;
  const appliedPromo = chosenReward ? null : (manualPromo ?? dealPromo ?? autoPromo);

  function applyPromo() {
    setPromoError(null);
    const typed = promoInput.trim().toUpperCase();
    const at = nowMicros();
    const match = promoCodes.find((p) => p.promo.code.toUpperCase() === typed && p.promo.active && (p.promo.expires_at === null || p.promo.expires_at > at));
    if (!match) return setPromoError(t("cart.promo.invalid"));
    if (match.standing?.blocked) return setPromoError(describeBlock(match.standing.blocked));
    if (!isPromoEligible(match.promo.requirement, lines, subtotal, completedOrderCount)) {
      return setPromoError(t("cart.promo.notYet", { requirement: describeRequirement(match.promo.requirement, itemName) }));
    }
    setManualPromo(match);
  }

  /// Takes off whichever code is applying.
  function removePromo() {
    if (manualPromo) setManualPromo(null);
    else if (dealPromo) cart.choosePromo(null);
    else setAutoPromoDismissed(true);
    setPromoInput("");
  }

  // What it takes off the food, against the cart as it is now: a
  // requirement can stop being met, or a reward newly find its item.
  const promoEvaluation = appliedPromo ? evaluatePromo(appliedPromo.promo, lines, subtotal, completedOrderCount) : null;
  const rewardDiscountCents = chosenReward ? rewardDiscount(chosenReward.benefit, lines) : 0;
  const discountCents = chosenReward ? rewardDiscountCents : (promoEvaluation?.effect.subtotalDiscountCents ?? 0);
  const promoNeedsItem = appliedPromo ? "FreeItem" in appliedPromo.promo.reward || "PercentOffItem" in appliedPromo.promo.reward : false;
  const promoAwaitingItem = !!appliedPromo && !!promoEvaluation?.eligible && promoNeedsItem && promoEvaluation.effect.itemEffects.length === 0;

  return {
    itemName,
    rewardsCard,
    rewardsProgram,
    chosenReward,
    toggleReward,
    rewardSheet: chooser.sheet,
    rewardDiscountCents,
    promoInput,
    setPromoInput,
    promoError,
    applyPromo,
    removePromo,
    appliedPromo,
    promoEvaluation,
    promoAwaitingItem,
    discountCents,
  };
}

export type Discounts = ReturnType<typeof useDiscounts>;
