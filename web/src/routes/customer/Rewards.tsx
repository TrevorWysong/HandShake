import { useState } from "react";
import { LoadProblem } from "../../components/LoadProblem";
import { formatNumber } from "../../lib/ui/format";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Cake, ChevronRight, Gift, Minus, Plus, ShoppingBag, Sparkles } from "lucide-react";
import clsx from "clsx";
import { myBirthMonth, myCard, myCards, setBirthMonth } from "../../holochain/zomes/rewards";
import { PendingList } from "../../components/rewards/PendingPoints";
import { bytesToHex, hexToBytes } from "../../holochain/decode";
import { useResource } from "../../lib/hooks/useResource";
import { fetchMenu } from "../../lib/storefront/menu";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { ACCENTS, expiresAt, tierOf } from "../../lib/rewards/rewards";
import { RewardsCard } from "../../components/rewards/RewardsCard";
import { HowYouEarn, RewardRail, RewardTile, TierLadder } from "../../components/rewards/RewardPieces";
import { Button, Card, Skeleton } from "../../components/ui";
import type { CardView, PointsLine } from "../../holochain/types";
import { useCart } from "../../store/cart";
import { appLocale, useT } from "../../i18n";
import { useAction } from "../../lib/hooks/useAction";

/// Every rewards card the customer holds, most recently used first, and
/// their birthday month.
export function RewardsPage() {
  const t = useT();
  const navigate = useNavigate();
  const { data: cards, error: cardsError, reload: reloadCards } = useResource("rewards:cards", myCards);

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-28 pt-5">
      <motion.div variants={fadeSlideUp} className="mb-5">
        <h1 className="text-2xl font-black tracking-tight text-ink-900 dark:text-ink-50">{t("rewards.title")}</h1>
        <p className="mt-1 text-sm text-ink-500">{t("rewards.subtitle")}</p>
      </motion.div>

      {cards === undefined && cardsError ? <LoadProblem error={cardsError} onRetry={reloadCards} /> : null}
      {cards === undefined && !cardsError && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-44 w-full rounded-[28px]" />
          <Skeleton className="h-44 w-full rounded-[28px]" />
        </div>
      )}
      {cards && cards.length === 0 && (
        <motion.div variants={fadeSlideUp} className="relative overflow-hidden rounded-[28px] bg-ink-900 p-7 text-white lg:max-w-xl">
          <div aria-hidden className="absolute -right-10 -top-16 h-48 w-48 rounded-full bg-handshake-500/40 blur-3xl" />
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/10">
            <Sparkles size={22} />
          </span>
          <p className="mt-4 text-lg font-black">{t("rewards.emptyTitle")}</p>
          <p className="mt-1 text-sm text-white/70">{t("rewards.emptyBody")}</p>
          <Button className="mt-5" onClick={() => navigate("/customer")}>
            <ShoppingBag size={16} /> {t("rewards.findStores")}
          </Button>
        </motion.div>
      )}
      {/* One card under another on a phone; side by side on a wide screen. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards
          ?.filter((card) => card.program)
          .map((card) => (
            <motion.div key={bytesToHex(card.catalog_ref)} variants={fadeSlideUp}>
              <RewardsCard compact program={card.program!.program} storeName={card.store_name} balance={card.balance} tier={card.tier} pendingPoints={card.pending_points} onClick={() => navigate(`/rewards/${bytesToHex(card.catalog_ref)}`)} />
            </motion.div>
          ))}
      </div>

      <motion.div variants={fadeSlideUp} className="mt-6 lg:max-w-xl">
        <BirthdayCard />
      </motion.div>
    </motion.div>
  );
}

/// A month's name (1 to 12) in the app's language.
const monthName = (month: number) => new Date(2000, month - 1, 1).toLocaleDateString(appLocale(), { month: "long" });

/// The customer's birth month -- set once, for every store's birthday treat.
function BirthdayCard() {
  const t = useT();
  const { data: month, reload } = useResource("rewards:birth-month", myBirthMonth);
  const [choice, setChoice] = useState(() => new Date().getMonth() + 1);
  const [confirming, setConfirming] = useState(false);
  // Set once, ever: it stays busy as the card shows it set.
  const saving = useAction();
  if (month === undefined) return null;
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-pink-400 to-fuchsia-600 text-white">
          <Cake size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("rewards.birthdayTitle")}</p>
          <p className="text-xs text-ink-500">{month ? t("rewards.birthdaySet", { month: monthName(month) }) : t("rewards.birthdayBody")}</p>
        </div>
      </div>
      {month === null && (
        <div className="mt-4">
          <div className="flex items-center justify-between rounded-2xl bg-ink-50 p-1.5 dark:bg-ink-800">
            <button type="button" aria-label={t("rewards.prevMonth")} onClick={() => setChoice((m) => (m === 1 ? 12 : m - 1))} className="grid h-9 w-9 place-items-center rounded-xl hover:bg-white dark:hover:bg-ink-700">
              <Minus size={16} />
            </button>
            <span className="text-sm font-bold text-ink-900 dark:text-ink-50">{monthName(choice)}</span>
            <button type="button" aria-label={t("rewards.nextMonth")} onClick={() => setChoice((m) => (m === 12 ? 1 : m + 1))} className="grid h-9 w-9 place-items-center rounded-xl hover:bg-white dark:hover:bg-ink-700">
              <Plus size={16} />
            </button>
          </div>
          {confirming ? (
            <div className="mt-3">
              <p className="mb-2 text-xs text-ink-500">{t("rewards.birthdayOnce", { month: monthName(choice) })}</p>
              <div className="flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={() => setConfirming(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  className="flex-1"
                  loading={saving.busy}
                  onClick={() =>
                    saving.run(async () => {
                      await setBirthMonth(choice);
                      await reload();
                    }, { stayBusy: true })
                  }
                >
                  {t("rewards.birthdayConfirm")}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" className="mt-3 w-full" onClick={() => setConfirming(true)}>
              {t("rewards.birthdaySave")}
            </Button>
          )}
          {saving.error && <p className="mt-2 text-xs text-red-500">{saving.error}</p>}
        </div>
      )}
    </Card>
  );
}

/// One store's card, opened: where the customer stands, what their points
/// buy, their status, how they earn and what they've done.
export function RewardsDetail() {
  const t = useT();
  const navigate = useNavigate();
  const { hash } = useParams<{ hash: string }>();
  const catalogRef = hexToBytes(hash ?? "");
  const { data: card, error: cardError, reload: reloadCard } = useResource(hash ? `rewards:card:${hash}` : null, () => myCard(catalogRef));
  const { data: menu = [] } = useResource(hash ? `store-menu-items:${hash}` : null, () => fetchMenu(catalogRef));
  // The reward in this store's cart, whose points are held.
  const bagReward = useCart(hash ?? null).reward;

  if (!card) {
    if (cardError) return <LoadProblem error={cardError} onRetry={reloadCard} />;
    return (
      <div className="px-4 pt-5">
        <Skeleton className="h-60 w-full rounded-[28px]" />
        <Skeleton className="mt-4 h-40 w-full" />
      </div>
    );
  }
  if (!card.program) {
    return <div className="px-6 py-20 text-center text-sm text-ink-400">{t("rewards.noProgram")}</div>;
  }
  const program = card.program.program;
  const rewards = [...program.rewards].sort((a, b) => a.cost - b.cost);
  // Points a reward in this store's bag holds, until the order goes in.
  const held = bagReward?.cost ?? 0;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-28 pt-4">
      <motion.button variants={fadeSlideUp} onClick={() => navigate(-1)} className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-500">
        <ArrowLeft size={16} /> {t("common.back")}
      </motion.button>
      <motion.div variants={fadeSlideUp}>
        <RewardsCard program={program} storeName={card.store_name} balance={Math.max(0, card.balance - held)} tier={card.tier} pendingPoints={card.pending_points} expiresAt={card.expires_at ?? expiresAt(program, card.state)} />
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mt-4 grid grid-cols-2 gap-2">
        <Button className="w-full" onClick={() => navigate(`/rewards/${hash}/redeem`)} disabled={rewards.length === 0}>
          <Gift size={16} /> {t("redeem.open")}
        </Button>
        <Button variant="ghost" className="w-full" onClick={() => navigate(`/customer/merchant/${hash}`)}>
          <ShoppingBag size={16} /> {t("rewards.order")}
        </Button>
      </motion.div>

      {card.pending.length > 0 && (
        <motion.section variants={fadeSlideUp} className="mt-7">
          <SectionTitle>{t("rewards.pending.title")}</SectionTitle>
          <PendingList program={program} pending={card.pending} />
        </motion.section>
      )}

      {rewards.length > 0 && (
        <motion.section variants={fadeSlideUp} className="mt-7">
          <SectionTitle>{t("rewards.yourRewards")}</SectionTitle>
          <RewardRail>
            {rewards.map((reward) => (
              <RewardTile key={reward.id} program={program} reward={reward} balance={card.balance} tier={card.tier} menu={menu} />
            ))}
          </RewardRail>
          <button onClick={() => navigate(`/rewards/${hash}/redeem`)} className="mt-1 text-xs font-semibold text-ink-500 hover:underline">
            {t("rewards.useAtCheckout")}
          </button>
        </motion.section>
      )}

      {program.tiers.length > 0 && (
        <motion.section variants={fadeSlideUp} className="mt-7">
          <SectionTitle>{t("rewards.status")}</SectionTitle>
          <TierLadder program={program} state={card.state} />
        </motion.section>
      )}

      <motion.section variants={fadeSlideUp} className="mt-7">
        <SectionTitle>{t("rewards.howYouEarn")}</SectionTitle>
        <HowYouEarn program={program} menu={menu} />
      </motion.section>

      <motion.section variants={fadeSlideUp} className="mt-7">
        <SectionTitle>{t("rewards.activity")}</SectionTitle>
        <Activity card={card} />
      </motion.section>
    </motion.div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-ink-400">{children}</h2>;
}

function lineLabel(line: PointsLine, t: ReturnType<typeof useT>): string {
  if (line.kind === "Earned") return t("rewards.line.earn");
  if (line.kind === "Spent") return t("rewards.line.redeem");
  if (line.kind === "Birthday") return t("rewards.line.birthday");
  return line.note ?? t("rewards.line.gift");
}

function Activity({ card }: { card: CardView }) {
  const t = useT();
  const program = card.program!.program;
  if (card.history.length === 0) return <p className="rounded-3xl bg-white p-5 text-sm text-ink-400 shadow-[var(--shadow-card)] dark:bg-ink-900">{t("rewards.noActivity")}</p>;
  const colors = ACCENTS[program.accent];
  return (
    <ul className="divide-y divide-ink-100 overflow-hidden rounded-3xl bg-white shadow-[var(--shadow-card)] dark:divide-ink-800 dark:bg-ink-900">
      {card.history.map((line) => (
        <li key={bytesToHex(line.entry)} className="flex items-center gap-3 px-5 py-3.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full" style={{ background: `${colors.from}22`, color: colors.to }}>
            {line.points < 0 ? <Gift size={14} /> : <Sparkles size={14} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{lineLabel(line, t)}</p>
            <p className="text-xs text-ink-400">{new Date(line.at / 1000).toLocaleDateString(appLocale(), { month: "short", day: "numeric", year: "numeric" })}</p>
          </div>
          <span className={clsx("text-sm font-black tabular-nums", line.points < 0 ? "text-ink-500" : "")} style={line.points >= 0 ? { color: colors.to } : undefined}>
            {line.points > 0 ? "+" : ""}
            {formatNumber(line.points)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/// A store's program on its page: the customer's card at a glance, or what
/// joining earns -- linking to the full card.
export function StoreRewardsStrip({ catalogHex }: { catalogHex: string }) {
  const t = useT();
  const navigate = useNavigate();
  const { data: card } = useResource(`rewards:card:${catalogHex}`, () => myCard(hexToBytes(catalogHex)));
  if (!card?.program || !card.program.program.active) return null;
  const program = card.program.program;
  const colors = ACCENTS[program.accent];
  const tier = card.state ? tierOf(program, card.state) : 0;
  const next = [...program.rewards].filter((r) => r.min_tier <= tier && r.cost > card.balance).sort((a, b) => a.cost - b.cost)[0];
  const joined = card.state !== null || card.pending.length > 0;
  return (
    <motion.button
      type="button"
      variants={fadeSlideUp}
      whileTap={{ scale: 0.98 }}
      onClick={() => navigate(`/rewards/${catalogHex}`)}
      className="mt-4 flex w-full items-center gap-3 overflow-hidden rounded-2xl p-3.5 text-left text-white"
      style={{ backgroundImage: `linear-gradient(120deg, ${colors.from}, ${colors.to})`, boxShadow: `0 12px 28px -14px ${colors.glow}` }}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/20">
        <Sparkles size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-black">
          {joined ? t("rewards.stripBalance", { points: formatNumber(card.balance), name: program.points_name }) : program.name}
          {card.pending_points > 0 && <span className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold">{t("rewards.pendingChip", { points: formatNumber(card.pending_points), name: program.points_name })}</span>}
        </p>
        <p className="truncate text-xs text-white/85">
          {joined
            ? next
              ? t("rewards.toNext", { points: formatNumber(next.cost - card.balance), name: next.name })
              : t("rewards.allUnlocked")
            : program.earn.welcome_bonus > 0
              ? t("rewards.stripJoinWelcome", { points: program.earn.points_per_dollar, name: program.points_name, welcome: program.earn.welcome_bonus })
              : t("rewards.earnRate", { points: program.earn.points_per_dollar, name: program.points_name })}
        </p>
      </div>
      <ChevronRight size={18} className="shrink-0 text-white/80" />
    </motion.button>
  );
}
