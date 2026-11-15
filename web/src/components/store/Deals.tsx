import { motion } from "framer-motion";
import { Bike, Check, Percent, Sparkles, Tag } from "lucide-react";
import clsx from "clsx";
import { listLivePromoCodes } from "../../holochain/zomes/catalog";
import { myPromoStanding } from "../../holochain/zomes/dispatch";
import { bytesToHex, decodeEntry, hexToBytes } from "../../holochain/decode";
import { useResource } from "../../lib/hooks/useResource";
import { blockedForGood, describeBlock, describeLimits, describeRequirement, describeReward } from "../../lib/storefront/promotions";
import { itemNamer, type ItemRow } from "../../lib/storefront/menu";
import { useCart } from "../../store/cart";
import type { PromoCode, PromoStanding } from "../../holochain/types";
import { useT } from "../../i18n";
import { deliveryDeals, type DeliveryShare } from "../../lib/storefront/deliveryShare";
import { SectionLabel } from "../ui";

interface Deal {
  hex: string;
  promo: PromoCode;
  standing: PromoStanding | undefined;
}

async function fetchDeals(catalogHex: string): Promise<Deal[]> {
  const catalogRef = hexToBytes(catalogHex);
  const [views, standings] = await Promise.all([listLivePromoCodes(catalogRef), myPromoStanding(catalogRef).catch(() => [] as PromoStanding[])]);
  return views.map((v) => {
    const hex = bytesToHex(v.original_action);
    return { hex, promo: decodeEntry<PromoCode>(v.record), standing: standings.find((s) => bytesToHex(s.promo) === hex) };
  });
}

/// A store's live deals, as a row of tickets: what each takes off, its terms,
/// and where the customer stands with it -- the way the big apps show
/// "Deals for you". Free delivery from an order size up leads, applied by
/// itself; a code the customer can use is added to their checkout with a
/// tap; one they can't use yet says why; one they never can again isn't
/// shown.
export function StoreDeals({ catalogHex, menu, share }: { catalogHex: string; menu: ItemRow[]; share: DeliveryShare }) {
  const t = useT();
  const { data: deals } = useResource(`store-deals:${catalogHex}`, () => fetchDeals(catalogHex));
  const { promoHex: chosen, choosePromo: choose } = useCart(catalogHex);
  const open = deals?.filter((deal) => !blockedForGood(deal.standing?.blocked)) ?? [];
  const delivering = deliveryDeals(share);
  const count = open.length + delivering.length;
  if (count === 0) return null;
  const itemName = itemNamer(menu);
  // The ones they can use first.
  const sorted = [...open].sort((a, b) => Number(!!a.standing?.blocked) - Number(!!b.standing?.blocked));
  // A lone deal fills the row; several scroll, each a ticket's width.
  const width = count === 1 ? "w-full" : "w-64";
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
      <SectionLabel icon={<Tag size={13} className="text-handshake-500" />} className="mb-2">{t("deals.title")}</SectionLabel>
      <div className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
        {delivering.map((deal) => (
          <Ticket
            key={deal.key}
            width={width}
            tone="delivery"
            icon={<Bike size={18} />}
            headline={deal.headline}
            terms={deal.terms}
            chips={[]}
            footer={
              <p className="flex items-center gap-1 text-xs font-bold text-presence-600 dark:text-presence-400">
                <Check size={13} /> {t("deals.auto")}
              </p>
            }
          />
        ))}
        {sorted.map(({ hex, promo, standing }) => {
          const blocked = standing?.blocked ?? null;
          const picked = chosen === hex;
          return (
            <Ticket
              key={hex}
              width={width}
              tone={blocked ? "muted" : "deal"}
              icon={"PercentOffSubtotal" in promo.reward || "PercentOffItem" in promo.reward ? <Percent size={18} /> : <Sparkles size={18} />}
              headline={describeReward(promo.reward, itemName)}
              terms={describeRequirement(promo.requirement, itemName)}
              chips={describeLimits(promo, standing)}
              footer={
                blocked ? (
                  <p className="text-xs font-semibold text-ink-500">{describeBlock(blocked)}</p>
                ) : promo.auto_apply ? (
                  <p className="flex items-center gap-1 text-xs font-bold text-presence-600">
                    <Check size={13} /> {t("deals.auto")}
                  </p>
                ) : (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.96 }}
                    onClick={() => choose(picked ? null : hex)}
                    className={clsx("flex w-full items-center justify-center gap-1.5 rounded-full py-2 text-xs font-bold transition", picked ? "bg-presence-500 text-white" : "bg-ink-900 text-white dark:bg-white dark:text-ink-900")}
                  >
                    {picked ? (
                      <>
                        <Check size={13} /> {t("deals.added")}
                      </>
                    ) : (
                      t("deals.use", { code: promo.code })
                    )}
                  </motion.button>
                )
              }
            />
          );
        })}
      </div>
    </motion.section>
  );
}

const TONES = {
  deal: { border: "border-handshake-200 dark:border-handshake-900/50", head: "bg-gradient-to-br from-handshake-50 to-white dark:from-handshake-900/30 dark:to-ink-900", icon: "bg-gradient-to-br from-handshake-400 to-handshake-600", text: "text-ink-900 dark:text-ink-50" },
  delivery: { border: "border-presence-500/30", head: "bg-gradient-to-br from-presence-500/10 to-white dark:from-presence-500/15 dark:to-ink-900", icon: "bg-gradient-to-br from-presence-500 to-presence-600", text: "text-ink-900 dark:text-ink-50" },
  muted: { border: "border-ink-100 dark:border-ink-800", head: "bg-ink-50 dark:bg-ink-800/50", icon: "bg-ink-300 dark:bg-ink-700", text: "text-ink-500" },
} as const;

/// One deal, as a ticket: the headline above a perforated edge, its terms
/// and what to do below.
function Ticket({ width, tone, icon, headline, terms, chips, footer }: { width: string; tone: keyof typeof TONES; icon: React.ReactNode; headline: string; terms: string; chips: string[]; footer: React.ReactNode }) {
  const look = TONES[tone];
  return (
    <div className={clsx("relative flex shrink-0 snap-start flex-col overflow-hidden rounded-2xl border bg-white shadow-[var(--shadow-card)] dark:bg-ink-900", width, look.border)}>
      <div className={clsx("flex items-start gap-3 p-4", look.head)}>
        <span className={clsx("grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white", look.icon)} aria-hidden>
          {icon}
        </span>
        <div className="min-w-0">
          <p className={clsx("line-clamp-2 text-sm font-black leading-tight", look.text)}>{headline}</p>
          <p className="mt-0.5 truncate text-xs text-ink-500">{terms}</p>
        </div>
      </div>
      <div className="relative border-t border-dashed border-ink-200 dark:border-ink-700">
        <span aria-hidden className="absolute -left-2 -top-2 h-4 w-4 rounded-full bg-cream dark:bg-ink-950" />
        <span aria-hidden className="absolute -right-2 -top-2 h-4 w-4 rounded-full bg-cream dark:bg-ink-950" />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4 pt-3">
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <span key={chip} className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold text-ink-600 dark:bg-ink-800 dark:text-ink-300">
              {chip}
            </span>
          ))}
        </div>
        <div className="mt-auto">{footer}</div>
      </div>
    </div>
  );
}
