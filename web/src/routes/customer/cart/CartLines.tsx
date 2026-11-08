// What's in the bag: each line with its choices and quantity, a reward
// redeemed into it shown as a reward -- its price struck through, free --
// and a goodie bag as one, with how long it's on offer.
import { motion } from "framer-motion";
import { Minus, Plus, Sparkles, Trash2 } from "lucide-react";
import { Card, StatNumber } from "../../../components/ui";
import { lineKey, useCart, type CartLine } from "../../../store/cart";
import { bytesEqual } from "../../../holochain/decode";
import { ACCENTS } from "../../../lib/rewards/rewards";
import { formatCents, formatClockTime, formatNumber } from "../../../lib/ui/format";
import { fadeSlideUp } from "../../../lib/ui/motion";
import type { ItemRow } from "../../../lib/storefront/menu";
import type { RewardsProgram } from "../../../holochain/types";
import { useT } from "../../../i18n";

/// A line whose choices are being changed.
export interface LineEdit {
  key: string;
  line: CartLine;
  row: ItemRow;
}

export function CartLines({ menuItems, program, rewardCost, onEdit }: { menuItems: ItemRow[]; program: RewardsProgram | null; rewardCost: number; onEdit: (edit: LineEdit) => void }) {
  const t = useT();
  const cart = useCart();
  return (
    <motion.div variants={fadeSlideUp}>
      <Card className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800">
        {cart.lines.map((line) => {
          const key = lineKey(line);
          if (line.rewardId != null && program) return <RewardLine key={key} line={line} program={program} cost={rewardCost} onRemove={() => cart.removeLine(key)} />;
          if (line.bag) return <BagLine key={key} line={line} onRemove={() => cart.removeLine(key)} />;
          // Only an item with choices has anything to edit.
          const row = line.selections.length > 0 ? menuItems.find((m) => bytesEqual(m.hash, line.itemRef)) : undefined;
          return (
            <div key={key} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{line.name}</p>
                {line.choiceLabels.length > 0 && <p className="line-clamp-2 text-xs text-ink-500 dark:text-ink-400">{line.choiceLabels.join(", ")}</p>}
                <p className="text-xs text-ink-400">
                  {t("cart.each", { price: formatCents(line.priceCents) })}
                  {!line.bag && menuItems.find((row) => bytesEqual(row.hash, line.itemRef))?.fullPriceCents && <span className="ml-1.5 font-semibold text-handshake-600 dark:text-handshake-400">{t("sale.onLine")}</span>}
                  {row && (
                    <button type="button" onClick={() => onEdit({ key, line, row })} className="ml-2 font-semibold text-handshake-600 hover:underline dark:text-handshake-400">
                      {t("common.edit")}
                    </button>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-ink-100 dark:bg-ink-800 px-1.5 py-1">
                <motion.button whileTap={{ scale: 0.85 }} onClick={() => cart.setQuantity(key, line.quantity - 1)} aria-label={t("item.fewer")} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 dark:hover:bg-ink-700">
                  {line.quantity === 1 ? <Trash2 size={14} className="text-ink-400" /> : <Minus size={14} className="text-ink-400" />}
                </motion.button>
                <span className="w-4 text-center text-sm font-semibold">{line.quantity}</span>
                <motion.button whileTap={{ scale: 0.85 }} onClick={() => cart.setQuantity(key, line.quantity + 1)} aria-label={t("item.more")} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 dark:hover:bg-ink-700">
                  <Plus size={14} className="text-ink-400" />
                </motion.button>
              </div>
              <StatNumber className="w-16 text-right text-sm">{formatCents(line.priceCents * line.quantity)}</StatNumber>
            </div>
          );
        })}
      </Card>
    </motion.div>
  );
}

function BagLine({ line, onRemove }: { line: CartLine; onRemove: () => void }) {
  const t = useT();
  const bag = line.bag!;
  const only = bag.pickup && bag.delivery ? null : bag.pickup ? t("cart.bag.pickupOnly") : t("cart.bag.deliveryOnly");
  return (
    <div className="flex items-center gap-3 p-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-300 to-handshake-500 text-base" aria-hidden>
        🎁
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{line.name}</p>
        <p className="text-xs text-ink-400">
          {t("cart.bag.until", { time: formatClockTime(bag.closes) })}
          {only && ` · ${only}`}
        </p>
      </div>
      <button type="button" onClick={onRemove} aria-label={t("cart.bag.remove")} className="grid h-8 w-8 place-items-center rounded-full text-ink-400 hover:bg-ink-100 hover:text-red-500 dark:hover:bg-ink-800">
        <Trash2 size={15} />
      </button>
      <StatNumber className="w-16 text-right text-sm">{formatCents(line.priceCents)}</StatNumber>
    </div>
  );
}

function RewardLine({ line, program, cost, onRemove }: { line: CartLine; program: RewardsProgram; cost: number; onRemove: () => void }) {
  const t = useT();
  const colors = ACCENTS[program.accent];
  return (
    <motion.div layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3 p-4" style={{ backgroundImage: `linear-gradient(90deg, ${colors.from}14, transparent)` }}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white" style={{ backgroundImage: `linear-gradient(135deg, ${colors.from}, ${colors.to})` }}>
        <Sparkles size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">
          {line.quantity > 1 && `${line.quantity}× `}
          {line.name}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs">
          <span className="rounded-full px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-white" style={{ background: colors.to }}>
            {t("cart.reward.badge")}
          </span>
          <span className="font-semibold tabular-nums" style={{ color: colors.to }}>
            {t("cart.reward.points", { points: formatNumber(cost), name: program.points_name })}
          </span>
        </p>
      </div>
      <motion.button whileTap={{ scale: 0.85 }} onClick={onRemove} aria-label={t("redeem.remove")} className="grid h-7 w-7 place-items-center rounded-full hover:bg-ink-100 dark:hover:bg-ink-800">
        <Trash2 size={14} className="text-ink-400" />
      </motion.button>
      <div className="w-16 text-right leading-tight">
        <p className="text-xs tabular-nums text-ink-400 line-through">{formatCents(line.priceCents * line.quantity)}</p>
        <p className="text-sm font-black" style={{ color: colors.to }}>
          {t("cart.reward.free")}
        </p>
      </div>
    </motion.div>
  );
}
