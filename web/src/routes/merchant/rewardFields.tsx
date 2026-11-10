// The pieces a store's rewards program is built from (Rewards.tsx): its
// sections and rows, and the fields for items, days, multipliers and rewards.
import { motion } from "framer-motion";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import clsx from "clsx";
import { bytesEqual, bytesToHex, hexToBytes } from "../../holochain/decode";
import { type ItemRow } from "../../lib/storefront/menu";
import { fadeSlideUp } from "../../lib/ui/motion";
import { fromMinorUnits, toMinorUnits, currencySymbol, formatNumber, wholeNumberIn } from "../../lib/ui/format";
import { ChoiceTermsEditor } from "./catalog/ChoiceTermsEditor";
import { Card, Field, GroupHeading, Input, Select, Switch } from "../../components/ui";
import { type ChoiceTerms, type PromoReward, type Reward } from "../../holochain/types";
import { useT } from "../../i18n";

export function Section({ icon: Icon, title, hint, children }: { icon: typeof Sparkles; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <motion.section variants={fadeSlideUp} className="mt-6">
      <GroupHeading icon={Icon} title={title} className="min-h-0" />
      {hint && <p className="mb-2 px-1 text-xs text-ink-400">{hint}</p>}
      <Card className="p-4">{children}</Card>
    </motion.section>
  );
}

export function Stat({ icon: Icon, label, value, sub }: { icon: typeof Sparkles; label: string; value: number; sub: string }) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-400">
        <Icon size={12} /> {label}
      </p>
      <p className="mt-1 text-2xl font-black tabular-nums text-ink-900 dark:text-ink-50">{formatNumber(value)}</p>
      <p className="text-xs text-ink-400">{sub}</p>
    </Card>
  );
}

export function Row({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <div className="grid flex-1 grid-cols-[1fr_auto] gap-2">{children}</div>
      <button type="button" aria-label={t("common.remove")} onClick={onRemove} className="text-ink-400 hover:text-red-500">
        <Trash2 size={15} />
      </button>
    </div>
  );
}

export function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button type="button" whileTap={{ scale: 0.97 }} onClick={onClick} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-ink-200 py-3 text-sm font-semibold text-ink-500 hover:border-handshake-300 hover:text-handshake-600 dark:border-ink-700">
      <Plus size={15} /> {children}
    </motion.button>
  );
}

/// An item off the menu (since removed) shows as such, not as whichever
/// item happens to be first.
export function ItemSelect({ menu, value, onChange }: { menu: ItemRow[]; value: Uint8Array; onChange: (item: Uint8Array) => void }) {
  const t = useT();
  const hex = bytesToHex(value);
  const gone = !menu.some((row) => bytesToHex(row.hash) === hex);
  return (
    <Select value={hex} onChange={(e) => onChange(hexToBytes(e.target.value))} aria-invalid={gone}>
      {gone && (
        <option value={hex} disabled>
          {t("rewardsAdmin.itemGone")}
        </option>
      )}
      {menu.map((row) => (
        <option key={bytesToHex(row.hash)} value={bytesToHex(row.hash)}>
          {row.item.name}
        </option>
      ))}
    </Select>
  );
}

export function MultiplierSelect({ options, value, onChange }: { options: number[]; value: number; onChange: (percent: number) => void }) {
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <Select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {all.map((percent) => (
        <option key={percent} value={percent}>
          {(percent / 100).toString()}×
        </option>
      ))}
    </Select>
  );
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function DayPicker({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const t = useT();
  return (
    <div className="flex gap-1.5">
      {DAYS.map((day, i) => {
        const on = (days & (1 << i)) !== 0;
        return (
          <button key={day} type="button" aria-pressed={on} onClick={() => onChange(days ^ (1 << i))} className={clsx("h-8 flex-1 rounded-lg text-[11px] font-bold transition", on ? "bg-ink-900 text-white dark:bg-white dark:text-ink-900" : "bg-white text-ink-400 dark:bg-ink-900")}>
            {t(`rewards.day.${day}`)}
          </button>
        );
      })}
    </div>
  );
}

/// A limit that's off until it's switched on.
export function OptionalNumber({ icon: Icon, label, hint, value, fallback, min = 1, max, suffix, onChange }: { icon?: typeof Sparkles; label: string; hint: string; value: number | null; fallback: number; min?: number; max: number; suffix: string; onChange: (value: number | null) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink-900 dark:text-ink-50">
            {Icon && <Icon size={14} className="text-ink-400" />} {label}
          </p>
          <p className="text-xs text-ink-400">{hint}</p>
        </div>
        <Switch checked={value !== null} onChange={(on) => onChange(on ? fallback : null)} label={label} />
      </div>
      {value !== null && <Input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Math.floor(Number(e.target.value) || min))))} suffix={suffix} className="mt-2" />}
    </div>
  );
}

type BenefitKind = "FreeItem" | "PercentOffItem" | "FlatOffSubtotal" | "PercentOffSubtotal";
const kindOf = (benefit: PromoReward): BenefitKind => Object.keys(benefit)[0] as BenefitKind;

/// One reward, edited.
export function RewardEditor({ catalogRef, reward, menu, tiers, onChange, onRemove }: { catalogRef: Uint8Array; reward: Reward; menu: ItemRow[]; tiers: string[]; onChange: (reward: Reward) => void; onRemove: () => void }) {
  const t = useT();
  const kind = kindOf(reward.benefit);
  const benefit = reward.benefit;
  // An item reward's item and the choices it covers, whichever kind it is.
  const gift = "FreeItem" in benefit ? benefit.FreeItem : "PercentOffItem" in benefit ? benefit.PercentOffItem : null;
  const giftRow = gift && menu.find((row) => bytesEqual(row.hash, gift.item_ref));
  const setGift = (patch: { item_ref?: Uint8Array; choices?: ChoiceTerms[]; percent?: number }) =>
    onChange({ ...reward, benefit: "FreeItem" in benefit ? { FreeItem: { ...benefit.FreeItem, ...patch } } : "PercentOffItem" in benefit ? { PercentOffItem: { ...benefit.PercentOffItem, ...patch } } : benefit });
  const setKind = (next: BenefitKind) => {
    const item = gift?.item_ref ?? menu[0]?.hash ?? new Uint8Array(39);
    const choices = gift?.choices ?? [];
    const benefit: PromoReward =
      next === "FreeItem" ? { FreeItem: { item_ref: item, quantity: 1, choices } } : next === "PercentOffItem" ? { PercentOffItem: { item_ref: item, percent: 50, quantity: 1, choices } } : next === "FlatOffSubtotal" ? { FlatOffSubtotal: 500 } : { PercentOffSubtotal: 10 };
    onChange({ ...reward, benefit });
  };
  return (
    <div className="rounded-2xl bg-ink-50 p-3 dark:bg-ink-800/60">
      <div className="mb-2 flex items-center gap-2">
        <Input maxLength={60} value={reward.name} onChange={(e) => onChange({ ...reward, name: e.target.value })} className="flex-1 py-2 font-semibold" aria-label={t("rewardsAdmin.rewardName")} />
        <button type="button" aria-label={t("common.remove")} onClick={onRemove} className="text-ink-400 hover:text-red-500">
          <Trash2 size={15} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("rewardsAdmin.cost")}>
          <Input type="number" min={1} max={1_000_000} value={reward.cost} onChange={(e) => onChange({ ...reward, cost: wholeNumberIn(e.target.value, 1, 1_000_000) })} suffix="pts" />
        </Field>
        <Field label={t("rewardsAdmin.gives")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as BenefitKind)}>
            {menu.length > 0 && <option value="FreeItem">{t("rewardsAdmin.kind.free")}</option>}
            {menu.length > 0 && <option value="PercentOffItem">{t("rewardsAdmin.kind.percentItem")}</option>}
            <option value="FlatOffSubtotal">{t("rewardsAdmin.kind.flat")}</option>
            <option value="PercentOffSubtotal">{t("rewardsAdmin.kind.percent")}</option>
          </Select>
        </Field>
        {gift && (
          <div className={"PercentOffItem" in benefit ? undefined : "col-span-2"}>
            <ItemSelect menu={menu} value={gift.item_ref} onChange={(item_ref) => setGift({ item_ref, choices: [] })} />
          </div>
        )}
        {"PercentOffItem" in benefit && <Input type="number" min={1} max={100} value={benefit.PercentOffItem.percent} onChange={(e) => setGift({ percent: wholeNumberIn(e.target.value, 1, 100) })} suffix="%" />}
        {gift && giftRow && (
          <div className="col-span-2">
            <ChoiceTermsEditor key={bytesToHex(gift.item_ref)} catalogRef={catalogRef} row={giftRow} value={gift.choices} onChange={(choices) => setGift({ choices })} />
          </div>
        )}
        {"FlatOffSubtotal" in reward.benefit && (
          <div className="col-span-2">
            <Input type="number" min={0.01} step="0.01" value={fromMinorUnits(reward.benefit.FlatOffSubtotal)} onChange={(e) => onChange({ ...reward, benefit: { FlatOffSubtotal: Math.max(1, toMinorUnits(Number(e.target.value) || 0)) } })} prefix={currencySymbol()} />
          </div>
        )}
        {"PercentOffSubtotal" in reward.benefit && (
          <div className="col-span-2">
            <Input type="number" min={1} max={100} value={reward.benefit.PercentOffSubtotal} onChange={(e) => onChange({ ...reward, benefit: { PercentOffSubtotal: wholeNumberIn(e.target.value, 1, 100) } })} suffix="%" />
          </div>
        )}
        {tiers.length > 0 && (
          <div className="col-span-2">
            <Select value={reward.min_tier} onChange={(e) => onChange({ ...reward, min_tier: Number(e.target.value) })}>
              <option value={0}>{t("rewardsAdmin.forEveryone")}</option>
              {tiers.map((name, i) => (
                <option key={i} value={i + 1}>
                  {t("rewardsAdmin.forTierUp", { tier: name })}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
    </div>
  );
}
