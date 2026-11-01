import { motion } from "framer-motion";
import { Check, Percent, Sparkles, Tag } from "lucide-react";
import clsx from "clsx";
import { listLivePromoCodes } from "../holochain/zomes/catalog";
import { myPromoStanding } from "../holochain/zomes/dispatch";
import { bytesToHex, decodeEntry, hexToBytes } from "../holochain/decode";
import { useResource } from "../lib/hooks/useResource";
import { describeBlock, describeLimits, describeRequirement, describeReward } from "../lib/menu/promotions";
import type { ItemRow } from "../lib/menu/menu";
import { useCart } from "../store/cart";
import type { PromoCode, PromoStanding } from "../holochain/types";
import { useT } from "../i18n";

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
/// "Deals for you". One the customer can use is added to their checkout
/// with a tap; one they can't says why.
export function StoreDeals({ catalogHex, menu }: { catalogHex: string; menu: ItemRow[] }) {
  const t = useT();
  const { data: deals } = useResource(`store-deals:${catalogHex}`, () => fetchDeals(catalogHex));
  const chosen = useCart((s) => s.promoHex);
  const choose = useCart((s) => s.choosePromo);
  if (!deals || deals.length === 0) return null;
  const itemName = (hex: string) => menu.find((m) => bytesToHex(m.hash) === hex)?.item.name;
  // The ones they can use first.
  const sorted = [...deals].sort((a, b) => Number(!!a.standing?.blocked) - Number(!!b.standing?.blocked));
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
        <Tag size={13} className="text-handshake-500" /> {t("deals.title")}
      </p>
      <div className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
        {sorted.map(({ hex, promo, standing }) => {
          const blocked = standing?.blocked ?? null;
          const picked = chosen === hex;
          return (
            <div
              key={hex}
              className={clsx(
                "relative flex w-64 shrink-0 snap-start flex-col overflow-hidden rounded-2xl border bg-white shadow-[var(--shadow-card)] dark:bg-ink-900",
                blocked ? "border-ink-100 dark:border-ink-800" : "border-handshake-200 dark:border-handshake-900/50",
              )}
            >
              {/* A ticket's edge: the headline above, the terms below. */}
              <div className={clsx("flex items-start gap-3 p-4", blocked ? "bg-ink-50 dark:bg-ink-800/50" : "bg-gradient-to-br from-handshake-50 to-white dark:from-handshake-900/30 dark:to-ink-900")}>
                <span className={clsx("grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white", blocked ? "bg-ink-300 dark:bg-ink-700" : "bg-gradient-to-br from-handshake-400 to-handshake-600")}>
                  {"PercentOffSubtotal" in promo.reward || "PercentOffItem" in promo.reward ? <Percent size={18} /> : <Sparkles size={18} />}
                </span>
                <div className="min-w-0">
                  <p className={clsx("line-clamp-2 text-sm font-black leading-tight", blocked ? "text-ink-500" : "text-ink-900 dark:text-ink-50")}>{describeReward(promo.reward, itemName)}</p>
                  <p className="mt-0.5 truncate text-xs text-ink-500">{describeRequirement(promo.requirement, itemName)}</p>
                </div>
              </div>
              <div className="relative border-t border-dashed border-ink-200 dark:border-ink-700">
                <span aria-hidden className="absolute -left-2 -top-2 h-4 w-4 rounded-full bg-cream dark:bg-ink-950" />
                <span aria-hidden className="absolute -right-2 -top-2 h-4 w-4 rounded-full bg-cream dark:bg-ink-950" />
              </div>
              <div className="flex flex-1 flex-col gap-2 p-4 pt-3">
                <div className="flex flex-wrap gap-1.5">
                  {describeLimits(promo, standing).map((chip) => (
                    <span key={chip} className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                      {chip}
                    </span>
                  ))}
                </div>
                <div className="mt-auto">
                  {blocked ? (
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
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </motion.section>
  );
}
