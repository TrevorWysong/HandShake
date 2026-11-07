// What a customer narrows the stores near them to: pure, so it's tested on its
// own, and written to the page's address, so a filter survives going into a
// store and back. A new filter is a field here, a line in `matches` and in the
// address, and a pill in `BrowseFilterBar`. The address is anyone's to type, so
// what comes from it is only ever one of the values below, or compared as text.
export const SORTS = ["relevance", "rating", "fastest", "nearest", "name"] as const;
export type BrowseSort = (typeof SORTS)[number];
export const MIN_RATINGS = [3.5, 4, 4.5] as const;
export const MAX_MINUTES = [20, 30, 45, 60] as const;

export interface BrowseFilters {
  query: string;
  cuisine: string | null;
  diets: string[];
  deals: boolean;
  openNow: boolean;
  favorites: boolean;
  minRating: number | null;
  maxMinutes: number | null;
  sort: BrowseSort;
}

/// What a filter needs to know of one store.
export interface StoreFacts {
  name: string;
  /// What a search reads: its name, cuisine, description and diets.
  searchable: string;
  cuisine: string;
  diets: string[];
  rating: number;
  reviewCount: number;
  open: boolean;
  favorite: boolean;
  deal: boolean;
  /// The longest its delivery estimate says, if there is one.
  minutes: number | null;
  km: number;
}

export const NO_FILTERS: BrowseFilters = { query: "", cuisine: null, diets: [], deals: false, openNow: false, favorites: false, minRating: null, maxMinutes: null, sort: "relevance" };

const oneOf = <T extends number>(values: readonly T[], text: string | null): T | null => values.find((value) => String(value) === text) ?? null;

export function readFilters(params: URLSearchParams): BrowseFilters {
  return {
    query: params.get("q") ?? "",
    cuisine: params.get("cuisine"),
    diets: params.getAll("diet"),
    deals: params.get("deals") === "1",
    openNow: params.get("open") === "1",
    favorites: params.get("fav") === "1",
    minRating: oneOf(MIN_RATINGS, params.get("rating")),
    maxMinutes: oneOf(MAX_MINUTES, params.get("time")),
    sort: SORTS.find((sort) => sort === params.get("sort")) ?? "relevance",
  };
}

export function writeFilters(filters: BrowseFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.cuisine) params.set("cuisine", filters.cuisine);
  for (const diet of filters.diets) params.append("diet", diet);
  if (filters.deals) params.set("deals", "1");
  if (filters.openNow) params.set("open", "1");
  if (filters.favorites) params.set("fav", "1");
  if (filters.minRating !== null) params.set("rating", String(filters.minRating));
  if (filters.maxMinutes !== null) params.set("time", String(filters.maxMinutes));
  if (filters.sort !== "relevance") params.set("sort", filters.sort);
  return params;
}

/// Whether anything narrows the list: the order it's in doesn't.
export const isNarrowed = (filters: BrowseFilters) => !!filters.query || !!filters.cuisine || filters.diets.length > 0 || filters.deals || filters.openNow || filters.favorites || filters.minRating !== null || filters.maxMinutes !== null;

export function matches(store: StoreFacts, filters: BrowseFilters): boolean {
  const words = filters.query.toLowerCase().split(/\s+/).filter(Boolean);
  const searchable = store.searchable.toLowerCase();
  return (
    words.every((word) => searchable.includes(word)) &&
    (!filters.cuisine || store.cuisine === filters.cuisine) &&
    filters.diets.every((diet) => store.diets.includes(diet)) &&
    (!filters.deals || store.deal) &&
    (!filters.openNow || store.open) &&
    (!filters.favorites || store.favorite) &&
    // A store nobody's reviewed has no rating to meet, and one with no
    // estimate no time: neither is promised to.
    (filters.minRating === null || (store.reviewCount > 0 && store.rating >= filters.minRating)) &&
    (filters.maxMinutes === null || (store.minutes !== null && store.minutes <= filters.maxMinutes))
  );
}

/// Open stores first, the way the list reads; then the chosen order. A store
/// with nothing to sort by comes after those that have it.
export function compareStores(a: StoreFacts, b: StoreFacts, sort: BrowseSort): number {
  if (a.open !== b.open) return a.open ? -1 : 1;
  switch (sort) {
    case "rating":
      return b.rating - a.rating || b.reviewCount - a.reviewCount;
    case "fastest":
      return (a.minutes ?? Infinity) - (b.minutes ?? Infinity) || 0;
    case "nearest":
      return a.km - b.km;
    case "name":
      return a.name.localeCompare(b.name);
    case "relevance":
      return 0;
  }
}

/// `items`, narrowed and in order.
export function applyFilters<T>(items: readonly T[], factsOf: (item: T) => StoreFacts, filters: BrowseFilters): T[] {
  return items.filter((item) => matches(factsOf(item), filters)).sort((a, b) => compareStores(factsOf(a), factsOf(b), filters.sort));
}
