// The pills above the stores near a customer. One a tap turns on or off; one with
// choices opens a sheet saying how many stores each would leave, so nobody
// picks their way to an empty list.
import { useState, type ReactNode } from "react";
import { ArrowUpDown, Check, ChevronDown, Clock, Heart, Leaf, Star, Tag, Utensils, X, type LucideIcon } from "lucide-react";
import clsx from "clsx";
import { MAX_MINUTES, MIN_RATINGS, NO_FILTERS, SORTS, type BrowseFilters, type BrowseSort } from "../../lib/storefront/browseFilters";
import { useT } from "../../i18n";
import { Button } from "../ui";
import { Sheet } from "../Sheet";

type Choosing = "sort" | "cuisine" | "rating" | "time" | "diet";

interface Props {
  filters: BrowseFilters;
  onChange: (next: BrowseFilters) => void;
  cuisines: string[];
  diets: string[];
  /// Whether any store has a delivery estimate: without one, time means nothing.
  hasTimes: boolean;
  /// How many stores the filters would leave, changed by `patch`.
  countWith: (patch: Partial<BrowseFilters>) => number;
  /// Called as a choice is about to be made, so every store near enough is
  /// read in time to count.
  onExplore?: () => void;
}

function Pill({ icon: Icon, active, label, opens, onClick }: { icon: LucideIcon; active: boolean; label: string; opens?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...(opens ? { "aria-haspopup": "dialog" as const } : { "aria-pressed": active })}
      className={clsx(
        "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-xs font-semibold transition active:scale-[0.97]",
        active ? "border-ink-900 bg-ink-900 text-white dark:border-white dark:bg-white dark:text-ink-900" : "border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-ink-800",
      )}
    >
      <Icon size={14} strokeWidth={2.25} fill={Icon === Star && active ? "currentColor" : "none"} />
      {label}
      {opens && <ChevronDown size={13} className="opacity-60" />}
    </button>
  );
}

/// A choice in a list, with how many stores it leaves.
function Row({ selected, label, count, onClick, multiple = false }: { selected: boolean; label: string; count: number; onClick: () => void; multiple?: boolean }) {
  return (
    <button
      type="button"
      role={multiple ? "checkbox" : "radio"}
      aria-checked={selected}
      onClick={onClick}
      className={clsx("flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold transition", selected ? "bg-ink-100 text-ink-900 dark:bg-ink-800 dark:text-white" : "text-ink-700 hover:bg-ink-50 dark:text-ink-200 dark:hover:bg-ink-800/60")}
    >
      <span className={clsx("grid h-5 w-5 shrink-0 place-items-center rounded-full border", multiple && "rounded-md", selected ? "border-ink-900 bg-ink-900 text-white dark:border-white dark:bg-white dark:text-ink-900" : "border-ink-300 dark:border-ink-600")}>
        {selected && <Check size={13} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-xs font-medium tabular-nums text-ink-400">{count}</span>
    </button>
  );
}

/// A threshold, as tiles side by side: "Any", then each step up.
function Tiles<T extends number>({ values, selected, label, icon, countOf, onPick, anyLabel }: { values: readonly T[]; selected: T | null; label: (value: T) => string; icon?: ReactNode; countOf: (value: T | null) => number; onPick: (value: T | null) => void; anyLabel: string }) {
  const t = useT();
  const tile = (value: T | null, text: string) => {
    const count = countOf(value);
    return (
      <button
        key={String(value)}
        type="button"
        role="radio"
        aria-checked={selected === value}
        onClick={() => onPick(value)}
        className={clsx(
          "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-2xl border px-1 py-3 transition active:scale-[0.97]",
          selected === value ? "border-ink-900 bg-ink-900 text-white dark:border-white dark:bg-white dark:text-ink-900" : "border-ink-200 text-ink-800 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-100 dark:hover:bg-ink-800/60",
          count === 0 && selected !== value && "opacity-50",
        )}
      >
        <span className="flex items-center gap-1 text-sm font-black tabular-nums">
          {value !== null && icon}
          {text}
        </span>
        <span className="text-[11px] font-medium opacity-70">{t("browse.filter.storeCount", { count })}</span>
      </button>
    );
  };
  return (
    <div role="radiogroup" className="flex gap-2 pb-2">
      {tile(null, anyLabel)}
      {values.map((value) => tile(value, label(value)))}
    </div>
  );
}

export function BrowseFilterBar({ filters, onChange, cuisines, diets, hasTimes, countWith, onExplore }: Props) {
  const t = useT();
  const [choosing, setChoosing] = useState<Choosing | null>(null);
  const choose = (sheet: Choosing) => {
    onExplore?.();
    setChoosing(sheet);
  };
  const set = (patch: Partial<BrowseFilters>) => onChange({ ...filters, ...patch });
  const pick = (patch: Partial<BrowseFilters>) => {
    set(patch);
    setChoosing(null);
  };
  const close = () => setChoosing(null);
  const narrowed = filters.cuisine || filters.diets.length > 0 || filters.deals || filters.openNow || filters.favorites || filters.minRating !== null || filters.maxMinutes !== null || filters.sort !== "relevance";

  return (
    <>
      <div role="toolbar" aria-label={t("browse.filter.label")} className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 py-0.5">
        <Pill icon={ArrowUpDown} active={filters.sort !== "relevance"} label={filters.sort === "relevance" ? t("browse.filter.sort") : t(`browse.sort.${filters.sort}`)} opens onClick={() => choose("sort")} />
        <Pill icon={Tag} active={filters.deals} label={t("browse.filter.deals")} onClick={() => set({ deals: !filters.deals })} />
        <Pill icon={Star} active={filters.minRating !== null} label={filters.minRating !== null ? `${filters.minRating.toFixed(1)}+` : t("browse.filter.rating")} opens onClick={() => choose("rating")} />
        {hasTimes && <Pill icon={Clock} active={filters.maxMinutes !== null} label={filters.maxMinutes !== null ? t("browse.filter.under", { minutes: filters.maxMinutes }) : t("browse.filter.time")} opens onClick={() => choose("time")} />}
        <Pill icon={Clock} active={filters.openNow} label={t("browse.filter.openNow")} onClick={() => set({ openNow: !filters.openNow })} />
        {cuisines.length > 0 && <Pill icon={Utensils} active={!!filters.cuisine} label={filters.cuisine ?? t("browse.filter.cuisine")} opens onClick={() => choose("cuisine")} />}
        {diets.length > 0 && <Pill icon={Leaf} active={filters.diets.length > 0} label={filters.diets.length === 0 ? t("browse.filter.diet") : filters.diets.length === 1 ? filters.diets[0] : t("browse.filter.dietCount", { count: filters.diets.length })} opens onClick={() => choose("diet")} />}
        <Pill icon={Heart} active={filters.favorites} label={t("browse.favorites")} onClick={() => set({ favorites: !filters.favorites })} />
        {narrowed && (
          <button type="button" onClick={() => onChange({ ...NO_FILTERS, query: filters.query })} className="inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3 text-xs font-semibold text-handshake-700 hover:bg-handshake-50 dark:text-handshake-300 dark:hover:bg-handshake-900/20">
            <X size={13} /> {t("browse.filter.clear")}
          </button>
        )}
      </div>

      <Sheet open={choosing === "sort"} onClose={close} title={t("browse.filter.sortTitle")}>
        <div role="radiogroup" className="flex flex-col gap-1 pb-2">
          {SORTS.filter((sort: BrowseSort) => hasTimes || sort !== "fastest").map((sort) => (
            <button key={sort} type="button" role="radio" aria-checked={filters.sort === sort} onClick={() => pick({ sort })} className={clsx("flex items-center justify-between rounded-xl px-3 py-3 text-left text-sm font-semibold transition", filters.sort === sort ? "bg-ink-100 text-ink-900 dark:bg-ink-800 dark:text-white" : "text-ink-700 hover:bg-ink-50 dark:text-ink-200 dark:hover:bg-ink-800/60")}>
              {t(`browse.sort.${sort}`)}
              {filters.sort === sort && <Check size={16} strokeWidth={3} />}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={choosing === "rating"} onClose={close} title={t("browse.filter.ratingTitle")} subtitle={t("browse.filter.ratingDetail")}>
        <Tiles values={MIN_RATINGS} selected={filters.minRating as (typeof MIN_RATINGS)[number] | null} label={(value) => `${value.toFixed(1)}+`} icon={<Star size={12} fill="currentColor" />} anyLabel={t("browse.filter.any")} countOf={(minRating) => countWith({ minRating })} onPick={(minRating) => pick({ minRating })} />
      </Sheet>

      <Sheet open={choosing === "time"} onClose={close} title={t("browse.filter.timeTitle")} subtitle={t("browse.filter.timeDetail")}>
        <Tiles values={MAX_MINUTES} selected={filters.maxMinutes as (typeof MAX_MINUTES)[number] | null} label={(value) => String(value)} anyLabel={t("browse.filter.any")} countOf={(maxMinutes) => countWith({ maxMinutes })} onPick={(maxMinutes) => pick({ maxMinutes })} />
      </Sheet>

      <Sheet open={choosing === "cuisine"} onClose={close} title={t("browse.filter.cuisineTitle")}>
        <div role="radiogroup" className="flex flex-col gap-1 pb-2">
          <Row selected={!filters.cuisine} label={t("browse.all")} count={countWith({ cuisine: null })} onClick={() => pick({ cuisine: null })} />
          {cuisines.map((cuisine) => (
            <Row key={cuisine} selected={filters.cuisine === cuisine} label={cuisine} count={countWith({ cuisine })} onClick={() => pick({ cuisine })} />
          ))}
        </div>
      </Sheet>

      <Sheet
        open={choosing === "diet"}
        onClose={close}
        title={t("browse.filter.dietTitle")}
        subtitle={t("browse.filter.dietDetail")}
        footer={<Button className="w-full" onClick={close}>{t("browse.filter.show", { count: countWith({}) })}</Button>}
      >
        <div role="group" className="flex flex-col gap-1 pb-2">
          {diets.map((diet) => {
            const on = filters.diets.includes(diet);
            const next = on ? filters.diets.filter((d) => d !== diet) : [...filters.diets, diet];
            return <Row key={diet} multiple selected={on} label={diet} count={countWith({ diets: on ? filters.diets : next })} onClick={() => set({ diets: next })} />;
          })}
        </div>
      </Sheet>
    </>
  );
}
