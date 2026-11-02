import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Check, Crown, Lock, ShoppingBag, Sparkles } from "lucide-react";
import clsx from "clsx";
import { myCard } from "../../holochain/zomes/rewards";
import { getCatalog } from "../../holochain/zomes/catalog";
import { bytesToHex, decodeEntry, hexToBytes } from "../../holochain/decode";
import { useResource } from "../../lib/hooks/useResource";
import { fetchMenu, itemNamer, type ItemRow } from "../../lib/storefront/menu";
import { describeReward } from "../../lib/storefront/promotions";
import { ACCENTS, redeemable, rewardLine, tierOf } from "../../lib/rewards/rewards";
import { RewardArt } from "../../components/rewards/RewardPieces";
import { Sheet } from "../../components/Sheet";
import { Button, Skeleton } from "../../components/ui";
import { useCart } from "../../store/cart";
import type { MerchantCatalog, Reward, RewardsProgram } from "../../holochain/types";
import { useT } from "../../i18n";

/// A store's rewards, to redeem -- the way the big chains' apps lay them
/// out: the member's points up top, rewards grouped by what they cost, and
/// a tap to put one in the bag. Its points are held from then (shown as
/// spent here and on the card) until the order goes in, and come back if
/// they take it out of the bag.
export function RedeemRewards() {
  const t = useT();
  const navigate = useNavigate();
  const { hash } = useParams<{ hash: string }>();
  const catalogRef = useMemo(() => hexToBytes(hash ?? ""), [hash]);
  const { data: card } = useResource(hash ? `rewards:card:${hash}` : null, () => myCard(catalogRef));
  const { data: menu = [] } = useResource(hash ? `store-menu-items:${hash}` : null, () => fetchMenu(catalogRef));
  const { data: store } = useResource(hash ? `catalog:${hash}` : null, () => getCatalog(catalogRef).then((r) => decodeEntry<MerchantCatalog>(r)));
  const cart = useCart();
  const [bucket, setBucket] = useState<number | null>(null);
  const [opening, setOpening] = useState<Reward | null>(null);
  const [added, setAdded] = useState(false);

  if (!card) {
    return (
      <div className="px-4 pt-5">
        <Skeleton className="h-48 w-full rounded-[28px]" />
        <div className="mt-4 grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48 w-full rounded-3xl" />
          ))}
        </div>
      </div>
    );
  }
  if (!card.program) return <div className="px-6 py-20 text-center text-sm text-ink-400">{t("rewards.noProgram")}</div>;

  const program = card.program.program;
  const colors = ACCENTS[program.accent];
  const tier = tierOf(program, card.state);
  // The reward in this store's bag, and the points it holds.
  const inBag = cart.reward && cart.catalogRef && bytesToHex(cart.catalogRef) === hash ? cart.reward : null;
  const held = inBag?.cost ?? 0;
  const available = Math.max(0, card.balance - held);
  // What a reward can draw on: the points not held -- plus its own, if it's the one in the bag.
  const spendable = (reward: Reward) => available + (inBag?.id === reward.id ? held : 0);
  const rewards = [...program.rewards].sort((a, b) => a.cost - b.cost);
  const buckets = [...new Set(rewards.map((r) => r.cost))];
  const shown = bucket === null ? rewards : rewards.filter((r) => r.cost === bucket);
  const itemName = itemNamer(menu);

  const redeem = (reward: Reward) => {
    if (!store) return;
    cart.redeem(catalogRef, store.owner, store.business_name, { id: reward.id, name: reward.name, cost: reward.cost }, rewardLine(reward, menu));
    setAdded(true);
  };

  return (
    <div className="pb-32">
      {/* The member's points, large -- what every reward below is measured against. */}
      <div className="relative overflow-hidden px-5 pb-8 pt-4 text-white" style={{ backgroundImage: `linear-gradient(150deg, ${colors.from}, ${colors.to})` }}>
        <div aria-hidden className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-white/10 blur-2xl" />
        <button onClick={() => navigate(-1)} className="relative flex items-center gap-1.5 text-sm font-semibold text-white/85">
          <ArrowLeft size={16} /> {card.store_name}
        </button>
        <p className="relative mt-5 text-xs font-bold uppercase tracking-[0.18em] text-white/75">{t("redeem.title", { name: program.name })}</p>
        <div className="relative mt-1 flex items-end gap-2">
          <AnimatePresence mode="popLayout">
            <motion.span key={available} initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -14, opacity: 0 }} className="text-5xl font-black tabular-nums tracking-tight">
              {available.toLocaleString()}
            </motion.span>
          </AnimatePresence>
          <span className="mb-1.5 text-sm font-bold text-white/80">{program.points_name}</span>
        </div>
        <div className="relative mt-3 flex flex-wrap gap-2">
          {tier > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-bold backdrop-blur-sm">
              <Crown size={11} /> {program.tiers[tier - 1]?.name}
            </span>
          )}
          {inBag && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-bold backdrop-blur-sm">
              <ShoppingBag size={11} /> {t("redeem.held", { points: held.toLocaleString(), name: program.points_name })}
            </span>
          )}
          {card.pending_points > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-bold backdrop-blur-sm">
              <Sparkles size={11} /> {t("rewards.pendingChip", { points: card.pending_points.toLocaleString(), name: program.points_name })}
            </span>
          )}
        </div>
      </div>

      {/* What they cost, as tabs: everything, or one price at a time. */}
      {buckets.length > 1 && (
        <div className="no-scrollbar sticky top-0 z-10 -mt-4 flex gap-2 overflow-x-auto rounded-t-3xl bg-cream px-4 pb-2 pt-4 dark:bg-ink-950">
          {[null, ...buckets].map((cost) => (
            <button
              key={cost ?? "all"}
              onClick={() => setBucket(cost)}
              className={clsx("shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold tabular-nums transition", bucket === cost ? "text-white shadow-sm" : "bg-white text-ink-600 dark:bg-ink-900 dark:text-ink-300")}
              style={bucket === cost ? { background: colors.to } : undefined}
            >
              {cost === null ? t("redeem.all") : t("redeem.bucket", { points: cost.toLocaleString() })}
            </button>
          ))}
        </div>
      )}

      {rewards.length === 0 ? (
        <p className="px-6 py-16 text-center text-sm text-ink-400">{t("redeem.none")}</p>
      ) : (
        <motion.div layout className={clsx("grid grid-cols-2 gap-3 px-4", buckets.length > 1 ? "pt-2" : "pt-5")}>
          <AnimatePresence>
            {shown.map((reward) => (
              <RedeemTile key={reward.id} program={program} reward={reward} balance={spendable(reward)} tier={tier} menu={menu} inBag={inBag?.id === reward.id} onOpen={() => setOpening(reward)} />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {/* The reward in the bag, pinned above the nav. */}
      <AnimatePresence>
        {inBag && !opening && (
          <motion.div initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} className="fixed inset-x-0 bottom-20 z-30 mx-auto max-w-md px-4 lg:bottom-6 lg:left-sidebar">
            <button onClick={() => navigate("/customer/cart")} className="flex w-full items-center gap-3 rounded-2xl bg-ink-900 px-4 py-3 text-left text-white shadow-xl dark:bg-white dark:text-ink-900">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full" style={{ background: colors.to }}>
                <Check size={15} strokeWidth={3} className="text-white" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold">{t("redeem.inBag", { reward: inBag.name })}</span>
                <span className="block text-xs opacity-70">{t("redeem.heldUntil")}</span>
              </span>
              <span className="text-xs font-bold">{t("redeem.viewBag")}</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <Sheet
        open={!!opening}
        onClose={() => {
          setOpening(null);
          setAdded(false);
        }}
        title={opening?.name ?? ""}
        subtitle={opening ? describeReward(opening.benefit, itemName) : undefined}
        footer={
          opening && (
            <div className="flex flex-col gap-2">
              {inBag && inBag.id !== opening.id && <p className="text-center text-xs text-ink-500">{t("redeem.replaces", { reward: inBag.name })}</p>}
              {inBag?.id === opening.id ? (
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    cart.releaseReward();
                    setOpening(null);
                  }}
                >
                  {t("redeem.remove")}
                </Button>
              ) : (
                <Button className="w-full" disabled={added || !store} onClick={() => redeem(opening)} style={{ background: colors.to }}>
                  {added ? (
                    <>
                      <Check size={16} strokeWidth={3} /> {t("redeem.added")}
                    </>
                  ) : (
                    t("redeem.cta", { points: opening.cost.toLocaleString(), name: program.points_name })
                  )}
                </Button>
              )}
            </div>
          )
        }
      >
        {opening && (
          <div className="pb-2">
            <div className="relative mx-auto mt-2 h-44 w-full overflow-hidden rounded-3xl">
              <RewardArt benefit={opening.benefit} menu={menu} accent={program.accent} />
              <AnimatePresence>
                {added && (
                  // A moment to see it land, then the bag -- when the moment's
                  // over, so closing the sheet first stays here.
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 1, 1] }}
                    transition={{ duration: 0.9, times: [0, 0.25, 1] }}
                    onAnimationComplete={() => navigate("/customer/cart")}
                    className="absolute inset-0 grid place-items-center bg-black/35 backdrop-blur-[1px]"
                  >
                    <motion.span initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring", damping: 12, stiffness: 260 }} className="grid h-16 w-16 place-items-center rounded-full bg-white" style={{ color: colors.to }}>
                      <Check size={32} strokeWidth={3} />
                    </motion.span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="mt-4 flex items-center justify-between rounded-2xl bg-ink-50 px-4 py-3 text-sm dark:bg-ink-800/60">
              <span className="text-ink-500">{t("redeem.after")}</span>
              <span className="font-black tabular-nums text-ink-900 dark:text-ink-50">
                {(spendable(opening) - opening.cost).toLocaleString()} {program.points_name}
              </span>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-ink-400">{t("redeem.how")}</p>
          </div>
        )}
      </Sheet>
    </div>
  );
}

/// One reward on the redeem screen: its picture and price, and whether it's
/// theirs now -- or how far off, or for which status level.
function RedeemTile({ program, reward, balance, tier, menu, inBag, onOpen }: { program: RewardsProgram; reward: Reward; balance: number; tier: number; menu: ItemRow[]; inBag: boolean; onOpen: () => void }) {
  const t = useT();
  const state = redeemable(program, balance, tier, reward);
  const colors = ACCENTS[program.accent];
  const ready = state === "ok";
  return (
    <motion.button
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      whileTap={ready ? { scale: 0.97 } : undefined}
      onClick={ready || inBag ? onOpen : undefined}
      disabled={!ready && !inBag}
      className={clsx("relative overflow-hidden rounded-3xl bg-white text-left shadow-[var(--shadow-card)] ring-2 dark:bg-ink-900", inBag ? "" : "ring-transparent")}
      style={inBag ? { ["--tw-ring-color" as string]: colors.to } : undefined}
    >
      <div className={clsx("relative aspect-[4/3] w-full", !ready && !inBag && "grayscale-[60%]")}>
        <RewardArt benefit={reward.benefit} menu={menu} accent={program.accent} />
        {inBag && (
          <span className="absolute inset-x-2 top-2 flex items-center justify-center gap-1 rounded-full py-1 text-[11px] font-bold text-white" style={{ background: colors.to }}>
            <Check size={12} strokeWidth={3} /> {t("redeem.tileInBag")}
          </span>
        )}
      </div>
      <div className="p-3">
        <p className="line-clamp-2 min-h-[2.5rem] text-sm font-bold leading-tight text-ink-900 dark:text-ink-50">{reward.name}</p>
        <p className="mt-1 text-xs font-black tabular-nums" style={{ color: colors.to }}>
          {reward.cost.toLocaleString()} {program.points_name}
        </p>
        {state === "points" && !inBag && (
          <div className="mt-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
              <motion.div className="h-full rounded-full" style={{ background: colors.to }} initial={{ width: 0 }} animate={{ width: `${Math.min(1, balance / reward.cost) * 100}%` }} transition={{ duration: 0.8 }} />
            </div>
            <p className="mt-1 text-[11px] text-ink-400">{t("rewards.toGo", { points: (reward.cost - balance).toLocaleString() })}</p>
          </div>
        )}
        {state === "tier" && (
          <p className="mt-2 flex items-center gap-1 text-[11px] font-semibold text-ink-500">
            <Lock size={11} /> {t("rewards.forTier", { tier: program.tiers[reward.min_tier - 1]?.name ?? "" })}
          </p>
        )}
        {state === "paused" && <p className="mt-2 text-[11px] text-ink-400">{t("rewards.paused")}</p>}
        {ready && !inBag && <p className="mt-2 text-xs font-bold text-ink-900 dark:text-ink-50">{t("redeem.tap")}</p>}
      </div>
    </motion.button>
  );
}
