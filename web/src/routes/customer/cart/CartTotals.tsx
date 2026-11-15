// What the order comes to: the food, its discount and tax, and for a
// delivery the driver's fee at its cap and the tip -- "up to", since a bid
// may come in lower -- and the points it'll earn.
import { motion } from "framer-motion";
import { Bike, Check, Sparkles } from "lucide-react";
import { Card, StatNumber } from "../../../components/ui";
import { ACCENTS } from "../../../lib/rewards/rewards";
import { formatCents, formatNumber } from "../../../lib/ui/format";
import { fadeSlideUp } from "../../../lib/ui/motion";
import type { RewardsProgram, TaxRate } from "../../../holochain/types";
import { useT } from "../../../i18n";
import type { Price } from "./pricing";

interface Props {
  fulfillment: "Delivery" | "Pickup";
  subtotalCents: number;
  price: Price;
  /// The code applying and what it takes off, or the reward and what it does.
  promo: { code: string; cents: number } | null;
  reward: { name: string; cents: number } | null;
  taxRates: TaxRate[];
  taxIncluded: boolean;
  tipCents: number;
  program: RewardsProgram | null;
  pointsPreview: number;
}

export function CartTotals({ fulfillment, subtotalCents, price, promo, reward, taxRates, taxIncluded, tipCents, program, pointsPreview }: Props) {
  const t = useT();
  const accent = program ? ACCENTS[program.accent].to : undefined;
  const delivery = fulfillment === "Delivery";
  return (
    <motion.div variants={fadeSlideUp}>
      <Card className="mt-4 flex flex-col gap-1.5 p-4 text-sm">
        <Row label={t("cart.subtotal")} value={formatCents(subtotalCents)} />
        {promo && <Row label={t("cart.promoLine", { code: promo.code })} value={`-${formatCents(promo.cents)}`} className="text-presence-600 dark:text-presence-400" />}
        {reward && reward.cents > 0 && (
          <div className="flex justify-between font-semibold" style={{ color: accent }}>
            <span>{reward.name}</span>
            <span>-{formatCents(reward.cents)}</span>
          </div>
        )}
        {taxRates.length > 0 && !taxIncluded && <Row label={taxRates[0].label || t("cart.tax")} value={formatCents(price.taxCents)} />}
        {delivery && (
          <Row
            label={
              <>
                {t("cart.deliveryFee")}
                {price.subsidyPercent > 0 && price.subsidyPercent < 100 && <span className="text-presence-600 dark:text-presence-400"> {t("cart.storeCovers", { percent: price.subsidyPercent })}</span>}
              </>
            }
            value={price.subsidyPercent === 100 ? t("cart.freeDelivery") : t("cart.upTo", { amount: formatCents(price.customerFeeShareCents) })}
            className={price.subsidyPercent === 100 ? "font-semibold text-presence-600 dark:text-presence-400" : undefined}
          />
        )}
        {delivery && (price.nextShare ? <ShareNudge next={price.nextShare} basisCents={price.discountedSubtotalCents} /> : price.reachedTier && <ShareReached percent={price.subsidyPercent} />)}
        {delivery && <Row label={t("cart.tip")} value={formatCents(tipCents)} />}
        <div className="mt-1 flex items-center justify-between border-t border-ink-100 dark:border-ink-800 pt-2">
          <span className="font-bold text-ink-900 dark:text-ink-50">{t("cart.estimatedTotal")}</span>
          {delivery && <span className="mr-1 text-xs text-ink-400">{t("cart.upToShort")}</span>}
          <StatNumber className="text-lg">{formatCents(delivery ? price.estimatedTotalCents : price.orderTotalCents)}</StatNumber>
        </div>
        {taxRates.length > 0 && taxIncluded && price.taxCents > 0 && (
          <p className="text-right text-xs text-ink-400">{t("cart.includesTax", { amount: formatCents(price.taxCents), tax: taxRates[0].label || t("cart.taxLower") })}</p>
        )}
        {program && pointsPreview > 0 && (
          <>
            <p className="mt-1 flex items-center justify-end gap-1 text-xs font-bold" style={{ color: accent }}>
              <Sparkles size={12} /> {t("rewards.willEarn", { points: formatNumber(pointsPreview), name: program.points_name })}
            </p>
            <p className="text-right text-[11px] text-ink-400">{t("rewards.arriveAfterRefunds")}</p>
          </>
        )}
      </Card>
    </motion.div>
  );
}

/// How much more food reaches a larger share of the delivery fee -- "Add
/// $3.20 for free delivery" -- with how far along the order is.
function ShareNudge({ next, basisCents }: { next: { percent: number; moreCents: number }; basisCents: number }) {
  const t = useT();
  const progress = Math.min(1, basisCents / (basisCents + next.moreCents));
  const amount = formatCents(next.moreCents);
  return (
    <div className="my-1 rounded-xl bg-presence-500/10 px-3 py-2.5 text-presence-700 dark:text-presence-300" role="status">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <Bike size={14} aria-hidden className="shrink-0" />
        {next.percent === 100 ? t("cart.share.toFree", { amount }) : t("cart.share.toMore", { amount, percent: next.percent })}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-presence-500/15" aria-hidden>
        <motion.div className="h-full rounded-full bg-presence-500" initial={false} animate={{ width: `${progress * 100}%` }} transition={{ type: "spring", stiffness: 140, damping: 22 }} />
      </div>
    </div>
  );
}

/// The order reached a larger share of the fee -- said once it has, so the
/// customer knows the bigger order paid off.
function ShareReached({ percent }: { percent: number }) {
  const t = useT();
  return (
    <motion.p initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} role="status" className="my-1 flex items-center gap-1.5 rounded-xl bg-presence-500/10 px-3 py-2 text-xs font-semibold text-presence-700 dark:text-presence-300">
      <Check size={14} strokeWidth={3} aria-hidden className="shrink-0" />
      {percent === 100 ? t("cart.share.gotFree") : t("cart.share.gotMore", { percent })}
    </motion.p>
  );
}

function Row({ label, value, className = "text-ink-400" }: { label: React.ReactNode; value: string; className?: string }) {
  return (
    <div className={`flex justify-between ${className}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
