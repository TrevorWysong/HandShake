// A store's share of each delivery fee: one share on every order, and, if
// it likes, more on bigger orders -- a fee is a smaller part of a bigger
// order, so covering it costs less of the margin. "Free delivery on orders
// $25+" is one tier of 100%, a tap away. Checked as validation checks it
// (`shareProblem`) before it's saved.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bike, Plus, Trash2 } from "lucide-react";
import { MAX_SUBSIDY_TIERS, type SubsidyTier } from "../../../holochain/types";
import { shareProblem, type DeliveryShare } from "../../../lib/storefront/deliveryShare";
import { currencySymbol, formatCents, fromMinorUnits, toMinorUnits } from "../../../lib/ui/format";
import { useAction } from "../../../lib/hooks/useAction";
import { Button, Field, Input, Notice } from "../../../components/ui";
import { useT } from "../../../i18n";

/// The order size a first "free delivery" tier starts at, in minor units.
const FREE_FROM_CENTS = 2500;

/// What customers get from a share, in a line each: the base, then each
/// tier -- for the store's own summary.
export function DeliveryShareSummary({ share }: { share: DeliveryShare }) {
  const t = useT();
  return (
    <>
      <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{share.base === 100 ? t("storeSettings.share.allFree") : share.base > 0 ? t("storeSettings.youCover", { percent: share.base }) : t("storeSettings.customerCovers")}</p>
      {share.tiers.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {share.tiers.map((tier) => (
            <li key={tier.from_cents} className="inline-flex items-center gap-1 rounded-full bg-presence-500/10 px-2.5 py-1 text-xs font-semibold text-presence-700 dark:text-presence-300">
              <Bike size={12} aria-hidden />
              {tier.percent === 100 ? t("storeSettings.share.freeFrom", { amount: formatCents(tier.from_cents) }) : t("storeSettings.share.percentFrom", { percent: tier.percent, amount: formatCents(tier.from_cents) })}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface TierDraft {
  id: number;
  dollars: string;
  percent: string;
}

let nextId = 0;
const draftOf = (tier: SubsidyTier): TierDraft => ({ id: nextId++, dollars: String(fromMinorUnits(tier.from_cents)), percent: String(tier.percent) });
const percentIn = (text: string) => Math.round(Number(text || 0));

/// Seeded from the saved share and most fee when it mounts.
export function DeliveryShareEditor({ initial, initialMaxCents, onSave }: { initial: DeliveryShare; initialMaxCents: number; onSave: (share: DeliveryShare, maxCents: number) => Promise<void> }) {
  const t = useT();
  const [baseDraft, setBaseDraft] = useState(String(initial.base));
  const [tiers, setTiers] = useState<TierDraft[]>(() => initial.tiers.map(draftOf));
  const [maxDraft, setMaxDraft] = useState(String(fromMinorUnits(initialMaxCents)));
  const save = useAction();
  const share: DeliveryShare = {
    base: percentIn(baseDraft),
    tiers: tiers.map((tier) => ({ from_cents: Number(tier.dollars) > 0 ? toMinorUnits(Number(tier.dollars)) : 0, percent: percentIn(tier.percent) })),
  };
  const problem = shareProblem(share);
  const dollars = Number(maxDraft);
  const maxCents = Number.isFinite(dollars) && dollars > 0 ? toMinorUnits(dollars) : null;
  const unchanged = JSON.stringify(share) === JSON.stringify({ base: initial.base, tiers: initial.tiers }) && maxCents === initialMaxCents;
  const hasFree = share.base === 100 || share.tiers.some((tier) => tier.percent === 100);
  const last = share.tiers[share.tiers.length - 1];
  const edit = (id: number, patch: Partial<TierDraft>) => setTiers((all) => all.map((tier) => (tier.id === id ? { ...tier, ...patch } : tier)));
  // A new tier starts past the last, covering more -- or, once the last is
  // free delivery, halfway to it, so a middle step can go in below.
  const roomBelowFree = (() => {
    if (last?.percent !== 100) return null;
    const before = share.tiers[share.tiers.length - 2];
    const from = Math.round(((before?.from_cents ?? 0) + last.from_cents) / 200) * 100;
    const percent = Math.round(((before?.percent ?? share.base) + 100) / 10) * 5;
    return from > (before?.from_cents ?? 0) && from < last.from_cents && percent > (before?.percent ?? share.base) && percent < 100 ? { from_cents: from, percent } : null;
  })();
  const addTier = () => {
    if (roomBelowFree) return setTiers((all) => [...all.slice(0, -1), draftOf(roomBelowFree), all[all.length - 1]]);
    const from = last ? last.from_cents + 1000 : 1500;
    const percent = Math.min(100, (last?.percent ?? share.base) + 25);
    setTiers((all) => [...all, draftOf({ from_cents: from, percent })]);
  };
  // Free delivery over a round amount: above every tier set so far.
  const addFree = () => setTiers((all) => [...all, draftOf({ from_cents: Math.max(FREE_FROM_CENTS, last ? last.from_cents + 500 : 0), percent: 100 })]);

  return (
    <div>
      <Field label={t("storeSettings.share.everyOrder")}>
        <Input type="number" min={0} max={100} step={5} value={baseDraft} onChange={(e) => setBaseDraft(e.target.value)} placeholder="50" suffix="%" className="w-28" />
      </Field>

      <div className="mt-4 rounded-xl bg-ink-50 p-3 dark:bg-ink-800/50">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-700 dark:text-ink-200">
          <Bike size={14} aria-hidden className="text-presence-600 dark:text-presence-400" /> {t("storeSettings.share.bigger")}
        </p>
        <p className="mt-0.5 text-xs text-ink-400">{t("storeSettings.share.biggerHint")}</p>
        {/* Two columns where there's room; stacked, each field labelled,
            where there isn't (a narrow phone, or large text). */}
        <div className="@container">
          {tiers.length > 0 && (
            <div className="mt-3 hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem] gap-x-2 text-[11px] font-semibold uppercase tracking-wide text-ink-400 @[18rem]:grid" aria-hidden>
              <span>{t("storeSettings.share.ordersFrom")}</span>
              <span>{t("storeSettings.share.youCover")}</span>
            </div>
          )}
          <AnimatePresence initial={false}>
            {tiers.map((tier, i) => (
              <motion.div key={tier.id} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="mt-2 grid grid-cols-1 items-center gap-x-2 gap-y-1.5 @[18rem]:mt-1.5 @[18rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem]" role="group" aria-label={t("storeSettings.share.tier", { n: i + 1 })}>
                  <div className="col-start-1">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-400 @[18rem]:hidden" aria-hidden>{t("storeSettings.share.ordersFrom")}</span>
                    <Input type="number" min={0} step={1} value={tier.dollars} onChange={(e) => edit(tier.id, { dollars: e.target.value })} prefix={currencySymbol()} aria-label={t("storeSettings.share.fromLabel", { n: i + 1 })} className="w-full" />
                  </div>
                  <div className="col-start-1 @[18rem]:col-start-2 @[18rem]:row-start-1">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-400 @[18rem]:hidden" aria-hidden>{t("storeSettings.share.youCover")}</span>
                    <Input type="number" min={1} max={100} step={5} value={tier.percent} onChange={(e) => edit(tier.id, { percent: e.target.value })} suffix="%" aria-label={t("storeSettings.share.percentLabel", { n: i + 1 })} className="w-full" />
                  </div>
                  <button type="button" onClick={() => setTiers((all) => all.filter((x) => x.id !== tier.id))} aria-label={t("storeSettings.share.removeTier", { n: i + 1 })} className="grid h-9 w-9 place-items-center justify-self-end rounded-full text-ink-400 transition hover:bg-white hover:text-red-500 @[18rem]:col-start-3 @[18rem]:row-start-1 @[18rem]:justify-self-auto dark:hover:bg-ink-700">
                    <Trash2 size={15} />
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        {tiers.length < MAX_SUBSIDY_TIERS && (
          <div className="mt-3 flex flex-wrap gap-2">
            {!hasFree && (
              <button type="button" onClick={addFree} className="inline-flex items-center gap-1 rounded-full bg-presence-500/15 px-3 py-1.5 text-xs font-semibold text-presence-700 transition hover:bg-presence-500/25 dark:text-presence-300 forced-colors:border forced-colors:border-solid">
                <Bike size={13} aria-hidden /> {t("storeSettings.share.addFree", { amount: formatCents(Math.max(FREE_FROM_CENTS, last ? last.from_cents + 500 : 0)) })}
              </button>
            )}
            {share.base < 100 && (last?.percent !== 100 || roomBelowFree) && (
              <button type="button" onClick={addTier} className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-sm transition hover:bg-ink-100 dark:bg-ink-700 dark:text-ink-100 forced-colors:border forced-colors:border-solid">
                <Plus size={13} aria-hidden /> {t("storeSettings.share.addTier")}
              </button>
            )}
          </div>
        )}
        {problem && tiers.length > 0 && (
          <p role="alert" className="mt-2 text-xs font-semibold text-red-600 dark:text-red-400">
            {t(`storeSettings.share.problem.${problem}`)}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label={t("storeSettings.mostFee")}>
          <Input type="number" min={0} step={1} value={maxDraft} onChange={(e) => setMaxDraft(e.target.value)} prefix={currencySymbol()} className="w-28" />
        </Field>
        <Button loading={save.busy} disabled={unchanged || maxCents === null || problem !== null} onClick={() => save.run(() => onSave(share, maxCents!))} className="px-4 py-2 text-xs">
          {t("common.save")}
        </Button>
      </div>
      {problem === "range" && tiers.length === 0 && <p role="alert" className="mt-2 text-xs font-semibold text-red-600 dark:text-red-400">{t("storeSettings.share.problem.range")}</p>}
      {save.error && <Notice className="mt-3">{save.error}</Notice>}
    </div>
  );
}
