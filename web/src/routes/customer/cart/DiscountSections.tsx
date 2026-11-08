// The order's one discount, as the customer chooses it: a reward from the
// store's program, or else a promo code (`useDiscounts`).
import { formatNumber } from "../../../lib/ui/format";
import { AnimatePresence, motion } from "framer-motion";
import { RewardRail, RewardTile } from "../../../components/rewards/RewardPieces";
import { Button, Input } from "../../../components/ui";
import { ACCENTS } from "../../../lib/rewards/rewards";
import { describeLimits, describeRequirement, describeReward } from "../../../lib/storefront/promotions";
import type { ItemRow } from "../../../lib/storefront/menu";
import { MAX_PROMO_CODE_CHARS } from "../../../holochain/types";
import { useT } from "../../../i18n";
import { Section } from "./CartPieces";
import type { Discounts } from "./useDiscounts";

/// The member's rewards at this store, cheapest first: one in the bag holds
/// its points until the order's placed (or it's taken out).
export function RewardsSection({ discounts, menuItems, onBrowse }: { discounts: Discounts; menuItems: ItemRow[]; onBrowse: () => void }) {
  const t = useT();
  const { rewardsProgram: program, rewardsCard: card, chosenReward, rewardDiscountCents } = discounts;
  if (!program || !card || program.rewards.length === 0) return null;
  const accent = ACCENTS[program.accent].to;
  const held = chosenReward?.cost ?? 0;
  return (
    <Section
      title={program.name}
      right={
        <span className="text-xs font-black tabular-nums" style={{ color: accent }}>
          {formatNumber(Math.max(0, card.balance - held))} {program.points_name}
          {held > 0 && <span className="ml-1 font-semibold text-ink-400">· {t("cart.reward.held", { points: formatNumber(held) })}</span>}
        </span>
      }
    >
      <RewardRail>
        {[...program.rewards]
          .sort((a, b) => a.cost - b.cost)
          .map((reward) => (
            <RewardTile key={reward.id} program={program} reward={reward} balance={card.balance} tier={card.tier} menu={menuItems} selected={chosenReward?.id === reward.id} onSelect={() => discounts.toggleReward(reward)} />
          ))}
      </RewardRail>
      {chosenReward && rewardDiscountCents === 0 && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("rewards.addItemToUse")}</p>}
      {chosenReward && rewardDiscountCents > 0 && <p className="mt-1 text-xs text-ink-500">{t("rewards.usingInstead")}</p>}
      <button type="button" onClick={onBrowse} className="mt-2 text-xs font-bold hover:underline" style={{ color: accent }}>
        {t("cart.reward.browse")} →
      </button>
    </Section>
  );
}

/// The code applying -- what it takes off, its limits, and whether the cart
/// still meets it -- or a box to enter one. Hidden while a reward is in the
/// bag: it takes the promo's place.
export function PromoSection({ discounts }: { discounts: Discounts }) {
  const t = useT();
  const { appliedPromo: applied, promoEvaluation, itemName } = discounts;
  if (discounts.chosenReward) return null;
  const limits = applied ? describeLimits(applied.promo, applied.standing) : [];
  return (
    <Section title={t("cart.promo.title")}>
      <AnimatePresence mode="wait">
        {applied ? (
          <motion.div key="applied" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} className="rounded-lg bg-presence-500/10 px-3 py-2 text-sm text-presence-600 dark:text-presence-400">
            <div className="flex items-center justify-between">
              <span className="font-mono font-semibold">
                {applied.promo.auto_apply && <span className="mr-1.5 rounded-full bg-presence-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">🎁 {t("cart.promo.loyalty")}</span>}
                {applied.promo.code}
              </span>
              <button onClick={discounts.removePromo} className="text-xs underline">
                {t("common.remove")}
              </button>
            </div>
            <p className="mt-0.5 text-xs opacity-80">{describeReward(applied.promo.reward, itemName)}</p>
            {limits.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {limits.map((chip) => (
                  <span key={chip} className="rounded-full bg-presence-500/15 px-2 py-0.5 text-[10px] font-semibold">
                    {chip}
                  </span>
                ))}
              </div>
            )}
            {!promoEvaluation?.eligible && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t("cart.promo.noLonger", { requirement: describeRequirement(applied.promo.requirement, itemName) })}</p>}
            {discounts.promoAwaitingItem && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("cart.promo.addItem")}</p>}
          </motion.div>
        ) : (
          <motion.div key="unapplied" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex gap-2">
            <Input maxLength={MAX_PROMO_CODE_CHARS} value={discounts.promoInput} onChange={(e) => discounts.setPromoInput(e.target.value)} placeholder={t("cart.promo.enter")} className="flex-1 font-mono" />
            <Button variant="ghost" className="px-4 py-2 text-xs" onClick={discounts.applyPromo}>
              {t("cart.promo.apply")}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
      {discounts.promoError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{discounts.promoError}</p>}
    </Section>
  );
}
