// How a store's rating is counted, when some of its reviews aren't: shown
// above its reviews, so a reader sees what the stars are made of.
import type { RatingSummary } from "../../holochain/types";
import { useT } from "../../i18n";
import { InfoSheet } from "../InfoSheet";

export function RatingCounted({ rating }: { rating: RatingSummary }) {
  const t = useT();
  if (rating.uncounted === 0) return null;
  const sections = (["why", "who", "later"] as const).map((part) => ({ title: t(`ratingCounted.${part}`), body: t(`ratingCounted.${part}Detail`) }));
  return (
    <div className="mt-6 flex items-start gap-2 rounded-2xl border border-ink-100 bg-white px-4 py-3 text-xs text-ink-500 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-400">
      <p className="flex-1 leading-relaxed">
        <span className="font-semibold text-ink-700 dark:text-ink-200">{t("ratingCounted.reviews", { count: rating.count + rating.uncounted })}</span>
        {" · "}
        {t("ratingCounted.uncounted", { count: rating.uncounted })}
      </p>
      <InfoSheet title={t("ratingCounted.how")} sections={sections} />
    </div>
  );
}
