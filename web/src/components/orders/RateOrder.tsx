// Rating an order once it's done -- its store, its driver (a delivery's),
// and its items -- for the delivery and pickup order pages alike. What's
// already been rated is read back from the conductor, not kept in memory,
// so a reload never offers it again and invites a duplicate; each rating
// that lands is recorded at once, so a failure partway never re-offers
// what landed.
import { useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";
import { getMyReviewsForOrder, submitItemReview, submitReview } from "../../holochain/zomes/reputation";
import { bytesToHex, decodeEntry, hexToBytes } from "../../holochain/decode";
import type { ActionHash, AgentPubKey, OrderLine, Review } from "../../holochain/types";
import { MAX_DESCRIPTION_CHARS } from "../../holochain/types";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";
import { fadeSlideUp } from "../../lib/ui/motion";
import { StarRatingInput } from "../StarRating";
import { Button, Card, Notice, Textarea } from "../ui";
import { useT } from "../../i18n";

interface Props {
  orderRef: ActionHash;
  order: { catalog_ref: ActionHash; lines: OrderLine[] };
  itemNames: Record<string, string>;
  /// A delivery's driver, to rate too.
  driver?: AgentPubKey | null;
  /// Ordered from the customer's own store: there's nothing to rate --
  /// validation refuses a rating of oneself anyway.
  selfOrder: boolean;
}

export function RateOrder({ orderRef, order, itemNames, driver = null, selfOrder }: Props) {
  const t = useT();
  const { data: rated, mutate } = useResource(`order-rated:${bytesToHex(orderRef)}`, async () => {
    const targets = (await getMyReviewsForOrder(orderRef)).map((r) => decodeEntry<Review>(r).target);
    return { store: targets.some((target) => "Store" in target), driver: targets.some((target) => "Driver" in target) };
  });
  const [store, setStore] = useState({ rating: 0, comment: "" });
  const [driverReview, setDriverReview] = useState({ rating: 0, comment: "" });
  const [itemRatings, setItemRatings] = useState<Record<string, number>>({});
  const [itemsRated, setItemsRated] = useState(false);
  const submitting = useAction();

  if (!rated) return null;
  const canRateStore = !rated.store && !selfOrder;
  const canRateDriver = !!driver && !rated.driver;
  // The order's dishes -- a goodie bag isn't one.
  const items = Object.keys(itemNames);
  const canRateItems = !itemsRated && !selfOrder && items.length > 0;
  const ratedItems = Object.entries(itemRatings).filter(([, rating]) => rating > 0);

  if (!canRateStore && !canRateDriver) {
    if (!rated.store && !rated.driver) return null;
    return (
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="mt-5 flex items-center gap-3 rounded-2xl bg-presence-500/10 p-4 text-presence-600 dark:text-presence-400">
        <CheckCircle2 size={20} />
        <p className="text-sm">{t("order.rate.thanks")}</p>
      </motion.div>
    );
  }

  const nothingChosen = (canRateStore ? store.rating : 0) === 0 && (canRateDriver ? driverReview.rating : 0) === 0 && (!canRateItems || ratedItems.length === 0);
  const submit = () => submitting.run(async () => {
    if (canRateStore && store.rating > 0) {
      await submitReview({ target: { Store: order.catalog_ref }, order_original_action: orderRef, rating: store.rating, comment: store.comment });
      mutate((prev) => ({ driver: prev?.driver ?? false, store: true }));
    }
    if (canRateDriver && driver && driverReview.rating > 0) {
      await submitReview({ target: { Driver: driver }, order_original_action: orderRef, rating: driverReview.rating, comment: driverReview.comment });
      mutate((prev) => ({ store: prev?.store ?? false, driver: true }));
    }
    if (canRateItems && ratedItems.length > 0) {
      for (const [hex, rating] of ratedItems) await submitItemReview({ item_ref: hexToBytes(hex), order_original_action: orderRef, rating, comment: "" });
      setItemsRated(true);
    }
  });

  return (
    <motion.div variants={fadeSlideUp}>
      <Card className="mt-5 flex flex-col gap-4 p-4">
        <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("order.rate.title")}</p>
        {canRateStore && <Rating label={t("order.rate.store")} placeholder={t("order.rate.storePlaceholder")} value={store} onChange={setStore} />}
        {canRateDriver && <Rating label={t("order.rate.driver")} placeholder={t("order.rate.driverPlaceholder")} value={driverReview} onChange={setDriverReview} />}
        {canRateItems && (
          <div>
            <p className="mb-1 text-xs font-semibold text-ink-500">{t("order.rate.items")}</p>
            <div className="flex flex-col gap-2">
              {items.map((hex) => (
                <div key={hex} className="flex items-center justify-between">
                  <span className="text-sm text-ink-700 dark:text-ink-300">{itemNames[hex]}</span>
                  <StarRatingInput value={itemRatings[hex] ?? 0} onChange={(rating) => setItemRatings((prev) => ({ ...prev, [hex]: rating }))} size={16} />
                </div>
              ))}
            </div>
          </div>
        )}
        {submitting.error && <Notice>{submitting.error}</Notice>}
        <Button loading={submitting.busy} disabled={nothingChosen} onClick={submit}>
          {t("order.rate.submit")}
        </Button>
      </Card>
    </motion.div>
  );
}

/// Stars for one thing, and -- once there are some -- what was good or bad
/// about it.
function Rating({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: { rating: number; comment: string }; onChange: (value: { rating: number; comment: string }) => void }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-ink-500">{label}</p>
      <StarRatingInput value={value.rating} onChange={(rating) => onChange({ ...value, rating })} />
      {value.rating > 0 && <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={value.comment} onChange={(e) => onChange({ ...value, comment: e.target.value })} rows={2} placeholder={placeholder} className="mt-2" />}
    </div>
  );
}
