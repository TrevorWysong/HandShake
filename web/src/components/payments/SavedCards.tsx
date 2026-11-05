// The cards the signed-in account keeps with a payee -- a store, for a
// standing order; or, between businesses, a store and its drivers -- each
// with when it's forgotten if unused, and a way to forget it now. Shown only
// when there are any.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CreditCard } from "lucide-react";
import { forgetSavedCard, mySavedCards } from "../../holochain/zomes/payments";
import { getCatalog } from "../../holochain/zomes/catalog";
import { bytesToHex, decodeEntry } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import type { MerchantCatalog, SavedCard } from "../../holochain/types";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";
import { formatDeadline } from "../../lib/ui/format";
import { useT } from "../../i18n";
import { Button, Card, GroupHeading, Notice } from "../ui";
import { InfoSheet } from "../InfoSheet";

/// Each card, with the name of the store it was last kept or used for.
async function fetchSavedCards(): Promise<{ card: SavedCard; store: string | null }[]> {
  const cards = await mySavedCards();
  return Promise.all(
    cards.map(async (card) => {
      const record = await getCatalog(card.store).catch(() => null);
      return { card, store: record ? decodeEntry<MerchantCatalog>(record).business_name : null };
    }),
  );
}

export function SavedCards() {
  const t = useT();
  const { data: cards = [], reload } = useResource(`saved-cards:${bytesToHex(myAgentPubKey())}`, fetchSavedCards);
  if (cards.length === 0) return null;
  const sections = (["where", "used", "forget", "wrong"] as const).map((part) => ({ title: t(`savedCards.why.${part}`), body: t(`savedCards.why.${part}Detail`) }));
  return (
    <motion.section className="mb-4">
      <GroupHeading icon={CreditCard} title={t("savedCards.title")} action={<InfoSheet title={t("savedCards.how")} sections={sections} />} />
      <Card className="divide-y divide-ink-100 dark:divide-ink-800">
        {cards.map(({ card, store }) => (
          <SavedCardRow key={bytesToHex(card.payee)} card={card} store={store ?? t("savedCards.aStore")} onForgotten={reload} />
        ))}
      </Card>
    </motion.section>
  );
}

/// One kept card: who has it, until when, and forgetting it -- asked once
/// more before it's done, since it can't be undone.
function SavedCardRow({ card, store, onForgotten }: { card: SavedCard; store: string; onForgotten: () => Promise<void> }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const action = useAction();
  const forget = () => action.run(async () => {
    await forgetSavedCard(card.payee);
    await onForgotten();
  });
  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{store}</p>
          <p className="text-xs text-ink-400">{t("savedCards.until", { date: formatDeadline(card.stands_until) })}</p>
        </div>
        {!confirming && (
          <Button variant="ghost" className="shrink-0 px-3 py-1.5 text-xs" onClick={() => setConfirming(true)}>
            {t("savedCards.forget")}
          </Button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {confirming && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-800/60">
            <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">{t("savedCards.confirm", { store })}</p>
            <div className="mt-3 flex gap-2">
              <Button variant="ghost" className="flex-1 py-2 text-xs" onClick={() => setConfirming(false)}>
                {t("common.back")}
              </Button>
              <Button variant="danger" className="flex-1 py-2 text-xs" loading={action.busy} onClick={forget}>
                {t("savedCards.forget")}
              </Button>
            </div>
            {action.error && <Notice className="mt-2">{action.error}</Notice>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
