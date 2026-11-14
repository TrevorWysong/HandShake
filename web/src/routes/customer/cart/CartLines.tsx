// What's in the bag: each line with its choices and quantity, a reward
// redeemed into it shown as a reward -- its price struck through, free --
// and a goodie bag as one, with how long it's on offer.
import { motion } from "framer-motion";
import { AlertTriangle, Minus, Plus, Sparkles, Trash2 } from "lucide-react";
import { Card, StatNumber } from "../../../components/ui";
import { lineKey, MAX_UNITS, useCart, type CartLine } from "../../../store/cart";
import { bytesEqual } from "../../../holochain/decode";
import { ACCENTS } from "../../../lib/rewards/rewards";
import { formatCents, formatClockTime, formatNumber } from "../../../lib/ui/format";
import { fadeSlideUp } from "../../../lib/ui/motion";
import type { ItemRow } from "../../../lib/storefront/menu";
import { choicesToKeep, type LineCheck } from "../../../lib/storefront/cartCheck";
import type { Groups } from "../../../lib/storefront/choices";
import type { RewardsProgram } from "../../../holochain/types";
import { useT } from "../../../i18n";

/// A line whose choices are being changed.
export interface LineEdit {
  key: string;
  line: CartLine;
  row: ItemRow;
}

/// `checks`: each line against the store as it is now, by `lineKey` -- one
/// that can't be ordered as it is says why beneath it, with what to do.
export function CartLines({ store, menuItems, program, rewardCost, checks, groups, onEdit }: { store: string; menuItems: ItemRow[]; program: RewardsProgram | null; rewardCost: number; checks: Map<string, LineCheck> | null; groups: Groups | null; onEdit: (edit: LineEdit) => void }) {
  const cart = useCart(store);
  return (
    <motion.div variants={fadeSlideUp}>
      <Card className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800">
        {cart.lines.map((line) => {
          const key = lineKey(line);
          const check = checks?.get(key);
          const row = menuItems.find((m) => bytesEqual(m.hash, line.itemRef));
          const problem = check?.kind === "gone" || check?.kind === "choose" ? check : null;
          return (
            <div key={key} className={problem ? "bg-amber-50/60 dark:bg-amber-900/10" : undefined}>
              <Line line={line} lineId={key} menuItems={menuItems} program={program} rewardCost={rewardCost} store={store} onEdit={onEdit} />
              {problem && (
                <LineProblem
                  name={line.name}
                  reason={problem.reason}
                  action={problem.kind === "choose" && row ? "choose" : "remove"}
                  onRemove={() => cart.removeLine(key)}
                  onChoose={() => row && onEdit({ key, line: groups ? { ...line, selections: choicesToKeep(row.item, line.selections, groups) } : line, row })}
                />
              )}
            </div>
          );
        })}
      </Card>
    </motion.div>
  );
}

/// Why a line can't be ordered as it is, and the one thing to do about it.
function LineProblem({ name, reason, action, onRemove, onChoose }: { name: string; reason: string; action: "remove" | "choose"; onRemove: () => void; onChoose: () => void }) {
  const t = useT();
  return (
    <div role="alert" className="flex items-center gap-2.5 px-4 pb-3.5 forced-colors:border-t forced-colors:border-solid">
      <AlertTriangle size={15} aria-hidden className="shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="min-w-0 flex-1 text-xs leading-snug text-amber-900 dark:text-amber-100">
        <span className="font-semibold">{action === "choose" ? t("cart.check.choicesChanged") : reason}</span>
        {action === "choose" && <span className="block text-amber-800/90 dark:text-amber-200/90">{reason}</span>}
      </p>
      <button
        type="button"
        onClick={action === "choose" ? onChoose : onRemove}
        aria-label={`${action === "choose" ? t("cart.check.chooseAgain") : t("cart.check.remove")}: ${name}`}
        className="shrink-0 rounded-full bg-ink-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-ink-700 dark:bg-white dark:text-ink-900 dark:hover:bg-ink-200 forced-colors:border forced-colors:border-solid"
      >
        {action === "choose" ? t("cart.check.chooseAgain") : t("cart.check.remove")}
      </button>
    </div>
  );
}

/// One line of the bag, as it was added: a reward, a goodie bag, or an item.
function Line({ line, lineId: key, menuItems, program, rewardCost, store, onEdit }: { line: CartLine; lineId: string; menuItems: ItemRow[]; program: RewardsProgram | null; rewardCost: number; store: string; onEdit: (edit: LineEdit) => void }) {
  const t = useT();
  const cart = useCart(store);
  if (line.rewardId != null && program) return <RewardLine line={line} program={program} cost={rewardCost} onRemove={() => cart.removeLine(key)} />;
  if (line.bag) return <BagLine line={line} onRemove={() => cart.removeLine(key)} />;
  // Only an item with choices has anything to edit.
  const row = line.selections.length > 0 ? menuItems.find((m) => bytesEqual(m.hash, line.itemRef)) : undefined;
  // The quantity and price wrap under the name when there isn't room for
  // all three -- large text, a narrow screen -- rather than squeezing it.
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
      <div className="min-w-[8rem] flex-1">
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
        <motion.button whileTap={{ scale: 0.85 }} onClick={() => cart.setQuantity(key, line.quantity + 1)} disabled={line.quantity >= MAX_UNITS} aria-label={t("item.more")} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 disabled:opacity-30 dark:hover:bg-ink-700">
          <Plus size={14} className="text-ink-400" />
        </motion.button>
      </div>
      <StatNumber className="ml-auto w-16 text-right text-sm">{formatCents(line.priceCents * line.quantity)}</StatNumber>
    </div>
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
