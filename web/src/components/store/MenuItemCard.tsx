import clsx from "clsx";
import { Plus, Star } from "lucide-react";
import type { ItemRow } from "../../lib/storefront/menu";
import type { ItemRatingSummary } from "../../holochain/zomes/reputation";
import { formatCents } from "../../lib/ui/format";
import { StatNumber } from "../ui";
import { useT } from "../../i18n";

/// One dish on a store's menu: what it is on the left, its photo on the
/// right with the add button over its corner. The whole card adds it (or
/// opens its choices) -- while it's available and the store takes orders,
/// now or scheduled for when it opens.
export function MenuItemCard({ row, rating, minAge, canAdd, onAdd }: { row: ItemRow; rating: ItemRatingSummary | undefined; minAge: number | null; canAdd: boolean; onAdd: () => void }) {
  const t = useT();
  const { item } = row;
  const tags = item.dietary_tags ?? [];
  return (
    <button
      type="button"
      disabled={!canAdd}
      onClick={onAdd}
      aria-label={t("store.add", { item: item.name })}
      className="group flex w-full items-stretch gap-4 rounded-2xl border border-ink-100 bg-white p-4 text-left transition hover:border-ink-200 hover:shadow-lg hover:shadow-ink-900/5 focus-visible:ring-2 focus-visible:ring-handshake-500 focus-visible:outline-none disabled:cursor-default disabled:hover:border-ink-100 disabled:hover:shadow-none dark:border-ink-800 dark:bg-ink-900 dark:hover:border-ink-700"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold text-ink-900 dark:text-ink-50">{item.name}</span>
        {item.description && <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-500">{item.description}</span>}
        <span className="mt-auto flex items-center gap-2 pt-2">
          <StatNumber className="text-sm">{formatCents(item.price_cents)}</StatNumber>
          {rating && rating.count > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-ink-400">
              <Star size={11} className="fill-amber-400 text-amber-400" /> {(rating.rating_sum / rating.count).toFixed(1)} ({rating.count})
            </span>
          )}
        </span>
        {(tags.length > 0 || (item.age_restricted && minAge)) && (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {item.age_restricted && minAge && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">{t("age.badge", { age: minAge })}</span>
            )}
            {tags.map((tag) => (
              <span key={tag} className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium text-ink-500 dark:bg-ink-800">
                {tag}
              </span>
            ))}
          </span>
        )}
        {!item.available && <span className="mt-1 text-xs font-medium text-red-600">{t("store.unavailable")}</span>}
      </span>
      <span className="relative shrink-0 self-center">
        {item.photo_data_uri && <img src={item.photo_data_uri} alt="" className="h-24 w-24 rounded-xl object-cover" />}
        <span
          aria-hidden
          className={clsx(
            "grid h-9 w-9 place-items-center rounded-full bg-ink-900 text-white shadow-sm transition group-hover:scale-110 group-active:scale-95 group-disabled:bg-ink-200 group-disabled:text-ink-400 group-disabled:group-hover:scale-100 dark:bg-white dark:text-ink-900",
            item.photo_data_uri && "absolute -right-2 -bottom-2 ring-4 ring-white dark:ring-ink-900",
          )}
        >
          <Plus size={18} />
        </span>
      </span>
    </button>
  );
}
