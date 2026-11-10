import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Cake, Clock, Crown, Flame, Gift, Hourglass, Palette, Sparkles, Trash2, Users } from "lucide-react";
import clsx from "clsx";
import { programOf, programStats, saveProgram } from "../../holochain/zomes/rewards";
import { deviceTimeZone, getCatalog } from "../../holochain/zomes/catalog";
import { bytesEqual, decodeEntry, hexToBytes } from "../../holochain/decode";
import { useMerchantStores, useMyStores } from "../../store/merchantStores";
import { useResource } from "../../lib/hooks/useResource";
import { fetchMenu, type ItemRow } from "../../lib/storefront/menu";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { fromMinorUnits, toMinorUnits, currencySymbol, wholeNumberIn } from "../../lib/ui/format";
import { ACCENT_NAMES, ACCENTS, describeHappyHour, starterProgram } from "../../lib/rewards/rewards";
import { RewardsCard } from "../../components/rewards/RewardsCard";
import { HowYouEarn, RewardRail, RewardTile } from "../../components/rewards/RewardPieces";
import { StoreSwitcher } from "../../components/store/StoreSwitcher";
import { PromosTabs } from "./Promos";
import { NoStoreYet } from "../../components/store/NoStoreYet";
import { Button, Field, Input, SectionLabel, Skeleton, Switch } from "../../components/ui";
import { MAX_HAPPY_HOURS, MAX_ITEM_BONUSES, MAX_REWARDS, MAX_TIERS, type MerchantCatalog, type PromoReward, type RewardsProgram } from "../../holochain/types";
import { useT } from "../../i18n";
import { useAction } from "../../lib/hooks/useAction";
import { toast } from "../../store/toast";
import { AddButton, DayPicker, ItemSelect, MultiplierSelect, OptionalNumber, RewardEditor, Row, Section, Stat } from "./rewardFields";

type Translate = ReturnType<typeof useT>;

/// What's wrong with a draft, in words -- the network's limits
/// (`RewardsProgram::problem`), told before saving.
function draftProblem(p: RewardsProgram, menu: ItemRow[], t: Translate): string | null {
  if (!p.name.trim() || !p.points_name.trim()) return t("rewardsAdmin.problem.names");
  if (p.earn.points_per_dollar < 1 || p.earn.points_per_dollar > 100) return t("rewardsAdmin.problem.rate");
  for (const [i, tier] of p.tiers.entries()) {
    if (!tier.name.trim()) return t("rewardsAdmin.problem.tierName");
    if (tier.threshold <= (i === 0 ? 0 : p.tiers[i - 1].threshold)) return t("rewardsAdmin.problem.tierOrder");
    if (tier.percent < (i === 0 ? 100 : p.tiers[i - 1].percent)) return t("rewardsAdmin.problem.tierRate");
  }
  for (const reward of p.rewards) {
    if (!reward.name.trim()) return t("rewardsAdmin.problem.rewardName");
    if (reward.cost < 1) return t("rewardsAdmin.problem.rewardCost");
    if (reward.min_tier > p.tiers.length) return t("rewardsAdmin.problem.rewardTier");
  }
  // An item since taken off the menu (`remove_menu_item`) can't be earned
  // on or given.
  const onMenu = (item: Uint8Array) => menu.some((row) => bytesEqual(row.hash, item));
  const gifts = p.rewards.flatMap(({ benefit }) => ("FreeItem" in benefit ? [benefit.FreeItem.item_ref] : "PercentOffItem" in benefit ? [benefit.PercentOffItem.item_ref] : []));
  if ([...p.earn.item_bonuses.map((bonus) => bonus.item_ref), ...gifts].some((item) => !onMenu(item))) return t("rewardsAdmin.problem.itemGone");
  for (const hour of p.earn.happy_hours) {
    if (hour.days === 0 || hour.start_minute >= hour.end_minute) return t("rewardsAdmin.problem.hours");
  }
  const dearest = Math.max(1, ...p.rewards.map((r) => r.cost));
  if (p.max_balance !== null && p.max_balance < dearest) return t("rewardsAdmin.problem.cap");
  if (p.expiry_days !== null && (p.expiry_days < 30 || p.expiry_days > 1095)) return t("rewardsAdmin.problem.expiry");
  return null;
}

/// The Rewards tab: the selected store's program, built with its card
/// drawn live above.
export function MerchantRewards() {
  const t = useT();
  const stores = useMyStores();
  const activeHex = useMerchantStores((s) => s.activeHex);
  if (stores !== null && stores.length === 0) return <NoStoreYet detail={t("rewardsAdmin.noStoreDetail")} />;
  if (stores === null || !activeHex) {
    return (
      <div className="px-4 pt-4">
        <Skeleton className="h-52 w-full rounded-[28px]" />
      </div>
    );
  }
  return <ProgramBuilder key={activeHex} storeHex={activeHex} />;
}

async function fetchBuilder(catalogRef: Uint8Array) {
  const [view, menu, record] = await Promise.all([programOf(catalogRef), fetchMenu(catalogRef), getCatalog(catalogRef)]);
  return { view, menu, store: decodeEntry<MerchantCatalog>(record) };
}

function ProgramBuilder({ storeHex }: { storeHex: string }) {
  const t = useT();
  const catalogRef = useMemo(() => hexToBytes(storeHex), [storeHex]);
  const { data, reload } = useResource(`rewards-admin:${storeHex}`, () => fetchBuilder(catalogRef));
  const { data: stats } = useResource(`rewards-stats:${storeHex}`, () => programStats(catalogRef));
  // The program as edited -- `null` until changed, the saved one till then.
  const [edited, setDraft] = useState<RewardsProgram | null>(null);
  const [previewPoints, setPreviewPoints] = useState(240);
  const action = useAction();

  // Its happy hours, birthdays and points years run on the store's clock:
  // the zone its hours are in, never one typed here.
  const program = edited ?? (data ? (data.view?.program ?? starterProgram(catalogRef, data.store.business_name)) : null);
  const draft = program && data ? { ...program, time_zone: data.store.time_zone || deviceTimeZone() } : null;

  if (!data || !draft) {
    return (
      <div className="px-4 pt-4">
        <StoreSwitcher />
        <PromosTabs />
        <Skeleton className="mt-4 h-52 w-full rounded-[28px]" />
        <Skeleton className="mt-4 h-40 w-full" />
      </div>
    );
  }
  const { menu, store } = data;
  const update = (change: (p: RewardsProgram) => RewardsProgram) => {
    setDraft(change(structuredClone(draft)));
  };
  const problem = draftProblem(draft, menu, t);
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.view?.program ?? null);
  const previewTier = draft.tiers.filter((tier) => previewPoints >= tier.threshold).length;

  function save() {
    if (!draft || problem) return;
    return action.run(async () => {
      await saveProgram(draft);
      await reload();
      toast(t("common.saved"));
    });
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-40 pt-4">
      <StoreSwitcher />
      <PromosTabs />
      <motion.div variants={fadeSlideUp} className="mb-4 mt-3 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-ink-900 dark:text-ink-50">{t("rewardsAdmin.title")}</h1>
          <p className="text-sm text-ink-500">{data.view ? t("rewardsAdmin.subtitleLive") : t("rewardsAdmin.subtitleNew")}</p>
        </div>
        {data.view && <Switch checked={draft.active} onChange={(active) => update((p) => ({ ...p, active }))} label={t("rewardsAdmin.running")} />}
      </motion.div>

      {/* The settings, and the card as members will see it, live -- kept in
          view while editing: stuck above them on a phone or tablet, beside
          them on a wide screen. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-8">
        <div className="contents lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1 lg:block">
          {/* The card as members will see it, live. */}
          <motion.div variants={fadeSlideUp} className="sticky top-[calc(var(--spacing-header)+0.5rem)] z-20 lg:static">
            <RewardsCard program={draft} storeName={store.business_name} balance={previewPoints} tier={previewTier} />
          </motion.div>
          <motion.div variants={fadeSlideUp} className="mt-3 flex items-center gap-3 px-1">
            <span className="shrink-0 text-xs font-semibold text-ink-400">{t("rewardsAdmin.previewAt")}</span>
            <input type="range" min={0} max={Math.max(1000, ...draft.rewards.map((r) => r.cost), ...draft.tiers.map((x) => x.threshold))} value={previewPoints} onChange={(e) => setPreviewPoints(Number(e.target.value))} className="flex-1 accent-handshake-500" aria-label={t("rewardsAdmin.previewAt")} />
          </motion.div>

          {stats && data.view && (
            <motion.div variants={fadeSlideUp} className="mt-5 grid grid-cols-2 gap-3">
              <Stat icon={Users} label={t("rewardsAdmin.stats.members")} value={stats.members} sub={t("rewardsAdmin.stats.active", { count: stats.active_members })} />
              <Stat icon={Sparkles} label={t("rewardsAdmin.stats.orders")} value={stats.orders} sub={t("rewardsAdmin.stats.ordersSub")} />
              <Stat icon={Gift} label={t("rewardsAdmin.stats.redeemed")} value={stats.redemptions} sub={t("rewardsAdmin.stats.rewards")} />
              <Stat icon={Crown} label={t("rewardsAdmin.stats.tiers")} value={draft.tiers.length} sub={t("rewardsAdmin.stats.levels")} />
            </motion.div>
          )}
        </div>
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <Section icon={Palette} title={t("rewardsAdmin.brand")}>
            <div className="grid grid-cols-1 gap-3">
              <Field label={t("rewardsAdmin.name")}>
                <Input maxLength={40} value={draft.name} onChange={(e) => update((p) => ({ ...p, name: e.target.value }))} />
              </Field>
              <Field label={t("rewardsAdmin.pointsName")}>
                <Input maxLength={20} value={draft.points_name} onChange={(e) => update((p) => ({ ...p, points_name: e.target.value }))} placeholder={t("rewardsAdmin.pointsPlaceholder")} />
              </Field>
              <Field label={t("rewardsAdmin.tagline")}>
                <Input maxLength={120} value={draft.tagline} onChange={(e) => update((p) => ({ ...p, tagline: e.target.value }))} placeholder={t("rewardsAdmin.taglineHint")} />
              </Field>
              <div>
                <p className="mb-2 text-xs font-semibold text-ink-500">{t("rewardsAdmin.colour")}</p>
                <div className="flex gap-2.5">
                  {ACCENT_NAMES.map((accent) => (
                    <motion.button
                      key={accent}
                      type="button"
                      whileTap={{ scale: 0.9 }}
                      aria-label={accent}
                      onClick={() => update((p) => ({ ...p, accent }))}
                      className={clsx("h-10 w-10 rounded-full ring-offset-2 transition dark:ring-offset-ink-900", draft.accent === accent ? "ring-2 ring-ink-900 dark:ring-white" : "")}
                      style={{ backgroundImage: `linear-gradient(135deg, ${ACCENTS[accent].from}, ${ACCENTS[accent].to})` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </Section>

          <Section icon={Sparkles} title={t("rewardsAdmin.earning")}>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-xs font-semibold text-ink-500">{t("rewardsAdmin.rate")}</span>
                  <span className="text-lg font-black tabular-nums text-ink-900 dark:text-ink-50">
                    {draft.earn.points_per_dollar} <span className="text-xs font-semibold text-ink-400">{t("rewardsAdmin.perDollar", { name: draft.points_name })}</span>
                  </span>
                </div>
                <input type="range" min={1} max={100} value={draft.earn.points_per_dollar} onChange={(e) => update((p) => ({ ...p, earn: { ...p.earn, points_per_dollar: Number(e.target.value) } }))} className="w-full accent-handshake-500" aria-label={t("rewardsAdmin.rate")} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("rewardsAdmin.welcome")}>
                  <Input type="number" min={0} max={100000} value={draft.earn.welcome_bonus} onChange={(e) => update((p) => ({ ...p, earn: { ...p.earn, welcome_bonus: wholeNumberIn(e.target.value, 0, 100000) } }))} suffix="pts" />
                </Field>
                <Field label={t("rewardsAdmin.minOrder")}>
                  <Input type="number" min={0} step="0.01" value={fromMinorUnits(draft.earn.min_order_cents)} onChange={(e) => update((p) => ({ ...p, earn: { ...p.earn, min_order_cents: toMinorUnits(Math.max(0, Number(e.target.value) || 0)) } }))} prefix={currencySymbol()} />
                </Field>
              </div>
              <OptionalNumber label={t("rewardsAdmin.capPerOrder")} hint={t("rewardsAdmin.capPerOrderHint")} value={draft.earn.max_per_order} fallback={500} max={1_000_000} suffix={draft.points_name} onChange={(max_per_order) => update((p) => ({ ...p, earn: { ...p.earn, max_per_order } }))} />
            </div>
          </Section>

          <Section icon={Flame} title={t("rewardsAdmin.boosts")} hint={t("rewardsAdmin.boostsHint")}>
            <SectionLabel className="mb-2">{t("rewardsAdmin.itemBoosts")}</SectionLabel>
            <div className="flex flex-col gap-2">
              {draft.earn.item_bonuses.map((bonus, i) => (
                <Row key={i} onRemove={() => update((p) => ({ ...p, earn: { ...p.earn, item_bonuses: p.earn.item_bonuses.filter((_, j) => j !== i) } }))}>
                  <ItemSelect menu={menu} value={bonus.item_ref} onChange={(item_ref) => update((p) => withBonus(p, i, { ...p.earn.item_bonuses[i], item_ref }))} />
                  <MultiplierSelect options={[150, 200, 300, 500, 1000]} value={bonus.percent} onChange={(percent) => update((p) => withBonus(p, i, { ...p.earn.item_bonuses[i], percent }))} />
                </Row>
              ))}
            </div>
            {draft.earn.item_bonuses.length < MAX_ITEM_BONUSES && menu.length > 0 && (
              <AddButton onClick={() => update((p) => ({ ...p, earn: { ...p.earn, item_bonuses: [...p.earn.item_bonuses, { item_ref: unusedItem(menu, p.earn.item_bonuses.map((b) => b.item_ref)), percent: 200 }] } }))}>{t("rewardsAdmin.addItemBoost")}</AddButton>
            )}

            <SectionLabel className="mt-5">{t("rewardsAdmin.happyHours")}</SectionLabel>
            <p className="mb-2 mt-0.5 text-xs text-ink-400">{t("rewardsAdmin.timeZoneNote", { zone: draft.time_zone.replace(/_/g, " ") })}</p>
            <div className="flex flex-col gap-3">
              {draft.earn.happy_hours.map((hour, i) => (
                <div key={i} className="rounded-2xl bg-ink-50 p-3 dark:bg-ink-800/60">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-600 dark:text-ink-300">
                      <Clock size={13} /> {describeHappyHour(hour.days, hour.start_minute, hour.end_minute, t)}
                    </p>
                    <button type="button" aria-label={t("common.remove")} onClick={() => update((p) => ({ ...p, earn: { ...p.earn, happy_hours: p.earn.happy_hours.filter((_, j) => j !== i) } }))} className="text-ink-400 hover:text-red-500">
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <DayPicker days={hour.days} onChange={(days) => update((p) => withHour(p, i, { ...p.earn.happy_hours[i], days }))} />
                  {/* Two times side by side, the multiplier beneath on a phone -- three abreast clips a time. */}
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Input type="time" value={clock(hour.start_minute)} onChange={(e) => update((p) => withHour(p, i, { ...p.earn.happy_hours[i], start_minute: minutes(e.target.value) }))} aria-label={t("rewardsAdmin.starts")} />
                    <Input type="time" value={clock(hour.end_minute)} onChange={(e) => update((p) => withHour(p, i, { ...p.earn.happy_hours[i], end_minute: minutes(e.target.value) || 1440 }))} aria-label={t("rewardsAdmin.ends")} />
                    <div className="col-span-2 sm:col-span-1">
                      <MultiplierSelect options={[150, 200, 300, 500]} value={hour.percent} onChange={(percent) => update((p) => withHour(p, i, { ...p.earn.happy_hours[i], percent }))} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {draft.earn.happy_hours.length < MAX_HAPPY_HOURS && (
              <AddButton onClick={() => update((p) => ({ ...p, earn: { ...p.earn, happy_hours: [...p.earn.happy_hours, { days: 0b0011111, start_minute: 14 * 60, end_minute: 16 * 60, percent: 200 }] } }))}>{t("rewardsAdmin.addHappyHour")}</AddButton>
            )}
          </Section>

          <Section icon={Gift} title={t("rewardsAdmin.rewards")} hint={t("rewardsAdmin.rewardsHint")}>
            {draft.rewards.length > 0 && (
              <div className="mb-4">
                <RewardRail>
                  {[...draft.rewards]
                    .sort((a, b) => a.cost - b.cost)
                    .map((reward) => (
                      <RewardTile key={reward.id} program={draft} reward={reward} balance={previewPoints} tier={previewTier} menu={menu} />
                    ))}
                </RewardRail>
              </div>
            )}
            <div className="flex flex-col gap-3">
              {draft.rewards.map((reward, i) => (
                <RewardEditor key={reward.id} catalogRef={catalogRef} reward={reward} menu={menu} tiers={draft.tiers.map((x) => x.name)} onChange={(next) => update((p) => ({ ...p, rewards: p.rewards.map((r, j) => (j === i ? next : r)) }))} onRemove={() => update((p) => ({ ...p, rewards: p.rewards.filter((_, j) => j !== i) }))} />
              ))}
            </div>
            {draft.rewards.length < MAX_REWARDS && (
              <AddButton
                onClick={() =>
                  update((p) => {
                    const id = Math.max(0, ...p.rewards.map((r) => r.id)) + 1;
                    const benefit: PromoReward = menu[0] ? { FreeItem: { item_ref: menu[0].hash, quantity: 1, choices: [] } } : { FlatOffSubtotal: 500 };
                    return { ...p, rewards: [...p.rewards, { id, name: menu[0] ? t("rewardsAdmin.freeNamed", { item: menu[0].item.name }) : t("rewardsAdmin.dollarsOff"), cost: 100 * id, benefit, min_tier: 0 }] };
                  })
                }
              >
                {t("rewardsAdmin.addReward")}
              </AddButton>
            )}
          </Section>

          <Section icon={Crown} title={t("rewardsAdmin.tiers")} hint={t("rewardsAdmin.tiersHint")}>
            <div className="flex flex-col gap-3">
              {draft.tiers.map((tier, i) => (
                <div key={i} className="rounded-2xl bg-ink-50 p-3 dark:bg-ink-800/60">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="grid h-7 w-7 place-items-center rounded-full text-white" style={{ backgroundImage: `linear-gradient(135deg, ${ACCENTS[draft.accent].from}, ${ACCENTS[draft.accent].to})` }}>
                      <Crown size={13} />
                    </span>
                    <Input maxLength={24} value={tier.name} onChange={(e) => update((p) => withTier(p, i, { ...p.tiers[i], name: e.target.value }))} className="flex-1 py-2" aria-label={t("rewardsAdmin.tierName")} />
                    <button type="button" aria-label={t("common.remove")} onClick={() => update((p) => ({ ...p, tiers: p.tiers.filter((_, j) => j !== i), rewards: p.rewards.map((r) => ({ ...r, min_tier: Math.min(r.min_tier, p.tiers.length - 1) })) }))} className="text-ink-400 hover:text-red-500">
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t("rewardsAdmin.tierAt")}>
                      <Input type="number" min={1} value={tier.threshold} onChange={(e) => update((p) => withTier(p, i, { ...p.tiers[i], threshold: wholeNumberIn(e.target.value, 1, 1_000_000_000) }))} suffix="pts" />
                    </Field>
                    <Field label={t("rewardsAdmin.tierEarns")}>
                      <MultiplierSelect options={[100, 110, 125, 150, 175, 200, 250, 300]} value={tier.percent} onChange={(percent) => update((p) => withTier(p, i, { ...p.tiers[i], percent }))} />
                    </Field>
                  </div>
                  <Input maxLength={120} value={tier.perk} onChange={(e) => update((p) => withTier(p, i, { ...p.tiers[i], perk: e.target.value }))} placeholder={t("rewardsAdmin.perkHint")} className="mt-2" />
                </div>
              ))}
            </div>
            {draft.tiers.length < MAX_TIERS && (
              <AddButton
                onClick={() =>
                  update((p) => {
                    const last = p.tiers[p.tiers.length - 1];
                    const names = ["Silver", "Gold", "Platinum", "Diamond"];
                    return { ...p, tiers: [...p.tiers, { name: names[p.tiers.length] ?? "Tier", threshold: (last?.threshold ?? 0) + 1000, percent: Math.min(300, (last?.percent ?? 100) + 25), perk: "" }] };
                  })
                }
              >
                {t("rewardsAdmin.addTier")}
              </AddButton>
            )}
          </Section>

          <Section icon={Cake} title={t("rewardsAdmin.extras")}>
            <div className="grid grid-cols-1 gap-4">
              <Field label={t("rewardsAdmin.birthday")}>
                <Input type="number" min={0} max={100000} value={draft.birthday_points} onChange={(e) => update((p) => ({ ...p, birthday_points: wholeNumberIn(e.target.value, 0, 100000) }))} suffix="pts" />
              </Field>
              <p className="-mt-2 text-xs text-ink-400">{t("rewardsAdmin.birthdayHint")}</p>
              <OptionalNumber icon={Hourglass} label={t("rewardsAdmin.expiry")} hint={t("rewardsAdmin.expiryHint")} value={draft.expiry_days} fallback={180} min={30} max={1095} suffix={t("rewardsAdmin.days")} onChange={(expiry_days) => update((p) => ({ ...p, expiry_days }))} />
              <OptionalNumber label={t("rewardsAdmin.maxBalance")} hint={t("rewardsAdmin.maxBalanceHint")} value={draft.max_balance} fallback={Math.max(5000, ...draft.rewards.map((r) => r.cost))} max={1_000_000_000} suffix={draft.points_name} onChange={(max_balance) => update((p) => ({ ...p, max_balance }))} />
            </div>
          </Section>

          <Section icon={Sparkles} title={t("rewardsAdmin.membersSee")}>
            <HowYouEarn program={draft} menu={menu} />
          </Section>
        </div>
      </div>

      {/* Saving, kept in reach -- while there's something to save (or a
          program to launch), or a problem to tell. */}
      <AnimatePresence>
        {(dirty || !data.view || problem || action.error) && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} className="fixed inset-x-0 bottom-20 z-30 px-4 lg:bottom-6 lg:left-sidebar">
            <div className="mx-auto max-w-lg rounded-2xl bg-white/90 p-3 shadow-[var(--shadow-float)] backdrop-blur-md dark:bg-ink-900/90">
              <AnimatePresence>
                {(problem || action.error) && (
                  <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mb-2 text-xs font-semibold text-red-600 dark:text-red-400">
                    {problem ?? action.error}
                  </motion.p>
                )}
              </AnimatePresence>
              <Button className="w-full" onClick={save} loading={action.busy} disabled={!!problem || (!dirty && !!data.view)}>
                {data.view ? t("rewardsAdmin.save") : t("rewardsAdmin.launch")}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

const clock = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const minutes = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const withBonus = (p: RewardsProgram, i: number, bonus: RewardsProgram["earn"]["item_bonuses"][number]) => ({ ...p, earn: { ...p.earn, item_bonuses: p.earn.item_bonuses.map((b, j) => (j === i ? bonus : b)) } });
const withHour = (p: RewardsProgram, i: number, hour: RewardsProgram["earn"]["happy_hours"][number]) => ({ ...p, earn: { ...p.earn, happy_hours: p.earn.happy_hours.map((h, j) => (j === i ? hour : h)) } });
const withTier = (p: RewardsProgram, i: number, tier: RewardsProgram["tiers"][number]) => ({ ...p, tiers: p.tiers.map((x, j) => (j === i ? tier : x)) });
const unusedItem = (menu: ItemRow[], used: Uint8Array[]) => (menu.find((m) => !used.some((u) => bytesEqual(u, m.hash))) ?? menu[0]).hash;
