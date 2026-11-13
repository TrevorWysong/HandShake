import { useCallback, useMemo, useState } from "react";
import { LoadProblem } from "../../components/LoadProblem";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PackageOpen, Search, X } from "lucide-react";
import { motion } from "framer-motion";
import { AREA_PRECISION, getNearbyListings } from "../../holochain/zomes/catalog";
import { RecurringDue } from "../../components/orders/RecurringDue";
import { bytesToHex } from "../../holochain/decode";
import { encodeGeohash } from "../../lib/places/geohash";
import { useSession } from "../../store/session";
import { useFavorites } from "../../lib/hooks/useFavorites";
import { usePolling, useResource } from "../../lib/hooks/useResource";
import { FIRST_PAGE, minutesFrom, useNearbyStores } from "../../store/nearbyStores";
import { inTiers, nearestFirst, pageByPage } from "../../lib/storefront/nearby";
import { formatCents, nowMicros } from "../../lib/ui/format";
import { RestaurantCard } from "../../components/store/RestaurantCard";
import { AddressSwitcher } from "../../components/places/AddressSwitcher";
import { BrowseFilterBar } from "../../components/store/BrowseFilterBar";
import { Button, EmptyState, SectionLabel, Skeleton } from "../../components/ui";
import { applyFilters, isNarrowed, matches, matchesQuery, NO_FILTERS, readFilters, writeFilters, type BrowseFilters, type StoreFacts } from "../../lib/storefront/browseFilters";
import { deliveryEstimate } from "../../lib/driving/eta";
import { staggerContainer } from "../../lib/ui/motion";
import { POLL } from "../../lib/network/poll";
import { useClock } from "../../lib/hooks/useClock";
import { storeStatus } from "../../lib/storefront/storeHours";
import { fartherThanKm } from "../../lib/storefront/fartherAway";
import { myBlockList } from "../../lib/reputation/myBlockList";
import { storeHidden } from "../../lib/reputation/blockPrints";
import { myAgentPubKey } from "../../holochain/client";
import { useT } from "../../i18n";

/// Stores read a page at a time while browsing.
const PAGE = 24;
/// How many of the nearest stores a search, filter or sort looks through:
/// a dense city's every listing could run to thousands.
const SEARCHED = 300;

// A store that just listed can take a while to be found -- its listing has
// to reach whichever peer answers this read, seconds to a minute here -- so
// the listings are polled, slowly (`POLL.slow`): stores open and close
// rarely. Each store shown is read again once its card is a few minutes old
// (`nearbyStores`).
//
// Paging is the network's own: every store is listed under its cell and the
// wider area around it (`AREA_PRECISION`). Browse reads the cells around
// someone first, ranks them nearest first from the listings alone, and
// reads stores a page at a time as the list scrolls; past the last of them,
// it reads the wider area, and goes on with the stores farther out. How far
// it's read is kept for the session, so coming back from a store finds the
// list where it was left.

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-ink-100/60 dark:border-ink-800">
      <Skeleton className="h-32 w-full rounded-none" />
      <div className="space-y-2 bg-white p-3 dark:bg-ink-900">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

export function Browse() {
  const now = useClock();
  const t = useT();
  const navigate = useNavigate();
  const location = useSession((s) => s.location);
  // In the address, so they're still there coming back from a store.
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const setFilters = (next: BrowseFilters) => setParams(writeFilters(next), { replace: true });
  const { favoritesHex, toggleFavorite } = useFavorites();

  // Every store near here, from its listing alone, nearest first. Keyed by
  // the browsing cell -- changing address drops any in-flight reply for the
  // old one instead of letting it overwrite the new list.
  const geohash = encodeGeohash(location.lat, location.lon);
  const area = geohash.slice(0, AREA_PRECISION);
  const { data: nearListings, error: listingsError, reload: reloadListings } = useResource(`browse-listings:${geohash}`, () => getNearbyListings(geohash), { pollMs: POLL.slow });
  const near = useMemo(() => nearListings && nearestFirst(nearListings, location), [nearListings, location]);

  // Browsing reads a page at a time, as the list scrolls; exploring --
  // searching, filtering, sorting, or about to -- reads the nearest
  // `SEARCHED`, so every choice counts what's really near.
  const [opened, setOpened] = useState(false);
  const exploring = opened || isNarrowed(filters) || filters.sort !== "relevance";
  const paging = useNearbyStores((s) => s.paging[geohash]) ?? FIRST_PAGE;
  const setPaging = useNearbyStores((s) => s.setPaging);
  const pages = paging.pages;
  // The wider area, once the cells around here are looked through.
  const widen = paging.wide || (exploring && !!near && near.length < SEARCHED);
  const { data: widerListings } = useResource(widen ? `browse-listings:${area}` : null, () => getNearbyListings(area), { pollMs: POLL.slow });
  const wider = useMemo(() => widerListings && nearestFirst(widerListings, location), [widerListings, location]);
  const ordered = useMemo(() => near && inTiers(near, widen ? wider : undefined), [near, wider, widen]);
  const widening = widen && wider === undefined;
  const wanted = Math.min(ordered?.length ?? 0, exploring ? Math.max(pages * PAGE, SEARCHED) : pages * PAGE);
  const want = useMemo(() => ordered?.slice(0, wanted) ?? [], [ordered, wanted]);
  const read = useNearbyStores((s) => s.read);
  usePolling(() => read(want, location, filters.deals), { pollMs: POLL.slow }, !!ordered, `${geohash}:${wanted}:${filters.deals}:${location.lat},${location.lon}`);
  const known = useNearbyStores((s) => s.stores);
  const gone = useNearbyStores((s) => s.gone);
  const driveMinutes = useNearbyStores((s) => minutesFrom(s, location));
  const deals = useNearbyStores((s) => s.deals);
  // What's been read of them, nearest first, and how many are still coming.
  const listed = useMemo(() => want.flatMap((l) => known[l.hex] ?? []), [want, known]);
  // A store blocked either way isn't there for this customer
  // (docs/REPUTATION.md, phase 4): one they blocked, from their own list, or
  // one whose listing names them -- read from the listings already here.
  const me = myAgentPubKey();
  const listedKey = listed.map((r) => r.hex).join(",");
  const { data: blocked = [] } = useResource(listedKey ? `browse-blocked:${listedKey}` : null, async () => {
    const mine = await myBlockList({ Person: me });
    const flags = await Promise.all(listed.map((r) => storeHidden(r.catalog, r.hash, me, mine)));
    return listed.filter((_, i) => flags[i]).map((r) => r.hex);
  });
  const rows = useMemo(() => listed.filter((r) => !blocked.includes(r.hex)), [listed, blocked]);
  const pending = want.filter((l) => !known[l.hex] && !gone[l.hex]).length;
  // More to read: of what's listed, or farther out.
  const more = !!ordered && (wanted < ordered.length || !widen);
  const found = ordered?.filter((l) => !gone[l.hex]).length ?? 0;

  // Bags still open to order, from the stores shown: one that closed since
  // the last read drops off (orders after its window are refused on-chain).
  const nowUs = nowMicros();
  // A search narrows them as it does stores: by what's in them, and whose.
  const catalogNameByHex = new Map(rows.map((r) => [r.hex, r.catalog.business_name]));
  const bags = rows
    .flatMap((r) => r.bags)
    .filter((r) => r.bag.pickup_window_end > nowUs && matchesQuery([r.bag.title, r.bag.description, catalogNameByHex.get(bytesToHex(r.bag.catalog_ref)) ?? ""].join(" "), filters.query));

  const stores = useMemo(
    () =>
      rows.map((row) => {
        const { catalog, hex } = row;
        const estimate = deliveryEstimate(catalog, location, driveMinutes?.[hex] ?? null);
        const facts: StoreFacts = {
          name: catalog.business_name,
          searchable: [catalog.business_name, catalog.cuisine_type, catalog.description, ...(catalog.dietary_tags ?? [])].join(" "),
          cuisine: catalog.cuisine_type,
          diets: catalog.dietary_tags ?? [],
          rating: row.rating,
          reviewCount: row.reviewCount,
          open: storeStatus(catalog, now).open,
          favorite: favoritesHex.has(hex),
          deal: row.bags.length > 0 || !!deals[hex]?.deal,
          minutes: estimate.toMinutes,
          km: estimate.km,
        };
        return { row, facts };
      }),
    [rows, location, driveMinutes, now, favoritesHex, deals],
  );
  // Among the stores that deliver here, those well past the rest.
  const fartherKm = useMemo(() => fartherThanKm(stores.filter(({ row, facts }) => facts.km <= row.catalog.max_delivery_radius_km).map(({ facts }) => facts.km)), [stores]);
  // Exploring orders everything read; browsing orders each page on its own,
  // so reading the next never moves what's above it.
  const filtered = useMemo(() => {
    const order = (page: typeof stores) => applyFilters(page, (store) => store.facts, filters);
    return exploring ? order(stores) : pageByPage(stores, PAGE, order);
  }, [stores, filters, exploring]);
  const options = (pick: (store: StoreFacts) => string[]) => [...new Set(stores.flatMap((store) => pick(store.facts).filter(Boolean)))].sort();
  const lookingForDeals = filters.deals && rows.some((r) => !deals[r.hex] && r.bags.length === 0);
  const narrowed = isNarrowed(filters);
  // Nothing to show yet, with more on its way -- or, with none around here,
  // before the wider area's been looked at.
  const loading = ordered === undefined || (rows.length === 0 && (pending > 0 || widening || !widen));

  // Reaching the end of the list reads the next page -- past the last store
  // around here, from the wider area. Keyed on what's still coming, so once a
  // page lands with the end still in view, the next one's read too.
  const nearCount = near?.length ?? 0;
  const seeMore = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || pending > 0) return;
      const next = { pages: pages + 1, wide: paging.wide || pages * PAGE >= nearCount };
      const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setPaging(geohash, next), { rootMargin: "800px 0px" });
      observer.observe(node);
      return () => observer.disconnect();
    },
    [pending, geohash, pages, paging.wide, nearCount, setPaging],
  );

  const openCount = (count: number) => (count === 0 ? t("browse.noneOpen") : t("browse.openCount", { count }));

  return (
    <div className="px-4 pt-4">
      <AddressSwitcher />

      <RecurringDue />

      <div className="mb-4 flex items-center gap-2 rounded-full border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 px-4 py-2.5 transition focus-within:border-handshake-400 focus-within:ring-2 focus-within:ring-handshake-100">
        <Search size={16} className="text-ink-400" />
        <input
          type="search"
          value={filters.query}
          onChange={(e) => setFilters({ ...filters, query: e.target.value })}
          placeholder={t("browse.search")}
          aria-label={t("browse.search")}
          className="w-full bg-transparent text-sm outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {filters.query && (
          <button type="button" onClick={() => setFilters({ ...filters, query: "" })} aria-label={t("browse.clearSearch")} className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-500 transition hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-300">
            <X size={13} />
          </button>
        )}
      </div>

      {bags.length > 0 && (
        <div className="mb-5">
          <SectionLabel icon={<PackageOpen size={13} className="text-handshake-500" />} className="mb-2">{t("browse.bagsNearMe")}</SectionLabel>
          <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
            {bags.map((row) => (
              <button
                key={bytesToHex(row.hash)}
                onClick={() => navigate(`/customer/merchant/${bytesToHex(row.bag.catalog_ref)}`)}
                className="w-40 shrink-0 overflow-hidden rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 text-left"
              >
                {row.bag.photo_data_uri ? (
                  <img src={row.bag.photo_data_uri} alt="" className="h-20 w-full object-cover" />
                ) : (
                  <div className="flex h-20 w-full items-center justify-center bg-gradient-to-br from-amber-300 to-handshake-500 text-2xl">🎁</div>
                )}
                <div className="p-2.5">
                  <p className="truncate text-xs font-semibold text-ink-900 dark:text-ink-50">{row.bag.title}</p>
                  <p className="truncate text-[11px] text-ink-400">{catalogNameByHex.get(bytesToHex(row.bag.catalog_ref)) ?? t("browse.nearbyRestaurant")}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-sm font-black text-handshake-600 dark:text-handshake-400">{formatCents(row.bag.price_cents)}</span>
                    <span className="text-[11px] text-ink-400 line-through">{formatCents(row.bag.original_value_cents)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <h1 className="mb-1 text-xl font-black tracking-tight">{t("browse.title")}</h1>
      <p className="mb-3 text-xs text-ink-400">
        {loading
          ? "…"
          : narrowed
            ? t("browse.matching", { count: filtered.length, total: rows.length })
            : more || pending > 0
              ? t("browse.nearbyCount", { count: found })
              : openCount(rows.filter((r) => storeStatus(r.catalog, now).open).length)}
      </p>

      {rows.length > 0 && (
        <BrowseFilterBar
          filters={filters}
          onChange={setFilters}
          onExplore={() => setOpened(true)}
          cuisines={options((store) => [store.cuisine])}
          diets={options((store) => store.diets)}
          hasTimes={stores.some((store) => store.facts.minutes !== null)}
          countWith={(patch) => stores.filter((store) => matches(store.facts, { ...filters, ...patch })).length}
        />
      )}

      {/* Nothing near could be read at all: why, and a way to try again. */}
      {ordered === undefined && listingsError ? <LoadProblem error={listingsError} onRetry={reloadListings} /> : null}

      {((loading && !(ordered === undefined && listingsError)) || lookingForDeals) && (
        <div className="grid grid-cols-2 gap-3 pb-6 md:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      )}

      {!loading && rows.length === 0 && <EmptyState title={t("browse.emptyTitle")} subtitle={t("browse.emptySubtitle")} />}

      {!loading && rows.length > 0 && !lookingForDeals && pending === 0 && filtered.length === 0 && (
        <div className="pb-6">
          <EmptyState title={t("browse.noMatchTitle")} subtitle={filters.query.trim() ? t("browse.noMatchSearch", { query: filters.query.trim() }) : t("browse.noMatchSubtitle")} />
          <div className="-mt-10 flex justify-center">
            <Button variant="ghost" onClick={() => setFilters(NO_FILTERS)}>{t("browse.filter.clear")}</Button>
          </div>
        </div>
      )}

      {!loading && !lookingForDeals && filtered.length > 0 && (
        <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {filtered.map(({ row: r, facts }) => (
            <RestaurantCard
              key={r.hex}
              catalogHash={r.hash}
              catalog={r.catalog}
              now={now}
              rating={r.rating}
              reviewCount={r.reviewCount}
              customer={location}
              driveMinutes={driveMinutes?.[r.hex] ?? null}
              favorited={facts.favorite}
              deal={filters.deals && facts.deal}
              farther={fartherKm !== null && facts.km > fartherKm}
              onToggleFavorite={() => toggleFavorite(r.hash)}
            />
          ))}
          {/* The next page on its way, where it'll land. */}
          {!exploring && (pending > 0 || widening) && Array.from({ length: widening ? 4 : Math.min(pending, 4) }).map((_, i) => <CardSkeleton key={`more-${i}`} />)}
        </motion.div>
      )}

      {/* Exploring: what's been looked through, and what's still being. */}
      {!loading && exploring && found > rows.length && (
        <p className="mt-4 text-center text-xs text-ink-400">
          {pending > 0 ? t("browse.searchingMore") : t("browse.searchedNearest", { count: rows.length, total: found })}
        </p>
      )}
      {!exploring && more && !widening && <div ref={seeMore} key={`${wanted}:${pending}:${widen}`} aria-hidden className="h-px" />}
      <div className="pb-6" />
    </div>
  );
}
