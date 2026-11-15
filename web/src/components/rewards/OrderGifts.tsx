// On a customer's order page, under the store's answer: points the store
// sent with the order -- an apology, a thank-you -- with its own words, what
// their points now come to, and the way to spend them. Points, never an
// item: what they're enough for is worked out from the rewards the store
// offers today, so it never promises one that's gone.
import { motion } from "framer-motion";
import { ChevronRight, Gift } from "lucide-react";
import { Link } from "react-router-dom";
import { bytesToHex } from "../../holochain/decode";
import { myCard, orderGifts } from "../../holochain/zomes/rewards";
import { useResource } from "../../lib/hooks/useResource";
import { POLL } from "../../lib/network/poll";
import { ACCENTS, rewardOffered } from "../../lib/rewards/rewards";
import { enoughFor } from "../../lib/orders/issueAnswer";
import { fetchMenu } from "../../lib/storefront/menu";
import { formatNumber } from "../../lib/ui/format";
import { useT } from "../../i18n";

export function OrderGifts({ orderRef, catalogRef }: { orderRef: Uint8Array; catalogRef: Uint8Array }) {
  const t = useT();
  const hex = bytesToHex(orderRef);
  const storeHex = bytesToHex(catalogRef);
  // A gift comes with no signal of its own: the store's answer to a report
  // does, so read again with it, and now and then besides.
  const { data: gifts } = useResource(`rewards:gifts:${hex}`, () => orderGifts(orderRef), { pollMs: POLL.signalled, refreshOn: (s: object) => "IssueReported" in s || "OrderUpdated" in s || "OrderChanged" in s });
  const given = (gifts?.length ?? 0) > 0;
  const { data: card } = useResource(given ? `rewards:card:${storeHex}` : null, () => myCard(catalogRef));
  const { data: menu } = useResource(given ? `store-menu-items:${storeHex}` : null, () => fetchMenu(catalogRef));
  const program = card?.program?.program;
  if (!gifts || !given || !card || !program) return null;
  const colors = ACCENTS[program.accent];
  const offered = program.active ? program.rewards.filter((r) => r.min_tier <= card.tier && rewardOffered(r, menu)) : [];
  const reward = menu ? enoughFor(offered, card.balance) : null;
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} aria-label={t("orderGift.label")} className="mt-5 overflow-hidden rounded-3xl bg-white shadow-[var(--shadow-card)] dark:bg-ink-900 forced-colors:border forced-colors:border-solid">
      <ul className="divide-y divide-ink-100 dark:divide-ink-800">
        {gifts.map((gift) => (
          <li key={bytesToHex(gift.grant)} className="flex items-start gap-3 p-4">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white" style={{ backgroundImage: `linear-gradient(135deg, ${colors.from}, ${colors.to})` }}>
              <Gift size={18} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("orderGift.sent", { store: card.store_name, points: formatNumber(gift.points), name: program.points_name })}</p>
              {gift.note.trim() && <p className="mt-1 text-sm leading-relaxed text-ink-600 dark:text-ink-300">“{gift.note.trim()}”</p>}
            </div>
          </li>
        ))}
      </ul>
      <Link to={`/rewards/${storeHex}`} className="flex items-center gap-3 border-t border-ink-100 bg-ink-50/60 px-4 py-3 text-xs text-ink-600 hover:bg-ink-50 dark:border-ink-800 dark:bg-ink-800/40 dark:text-ink-300 dark:hover:bg-ink-800/60">
        <span className="min-w-0 flex-1">
          {reward ? t("orderGift.enough", { points: formatNumber(card.balance), name: program.points_name, reward }) : t("orderGift.balance", { points: formatNumber(card.balance), name: program.points_name })}
        </span>
        <span className="flex shrink-0 items-center gap-0.5 font-bold" style={{ color: colors.to }}>
          {t("orderGift.see")} <ChevronRight size={14} aria-hidden />
        </span>
      </Link>
    </motion.section>
  );
}
