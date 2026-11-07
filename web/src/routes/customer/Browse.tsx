import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PackageOpen, Search } from "lucide-react";
import { motion } from "framer-motion";
import { getNearbyMerchants, getNearbyGoodieBags } from "../../holochain/zomes/catalog";
import { RecurringDue } from "../../components/orders/RecurringDue";
import { averageRating, getRatingSummary } from "../../holochain/zomes/reputation";
import { decodeEntry, bytesToHex } from "../../holochain/decode";
import { encodeGeohash } from "../../lib/places/geohash";
import { minutesTo } from "../../lib/driving/routing";
import { useSession } from "../../store/session";
import { useFavorites } from "../../lib/hooks/useFavorites";
import { useResource } from "../../lib/hooks/useResource";
import { formatCents, nowMicros } from "../../lib/ui/format";
import type { MerchantCatalog, GoodieBag } from "../../holochain/types";
import { RestaurantCard } from "../../components/store/RestaurantCard";
import { AddressSwitcher } from "../../components/places/AddressSwitcher";
import { BrowseFilterBar } from "../../components/store/BrowseFilterBar";
import { Button, EmptyState, SectionLabel, Skeleton } from "../../components/ui";
import { applyFilters, isNarrowed, matches, NO_FILTERS, readFilters, writeFilters, type BrowseFilters, type StoreFacts } from "../../lib/storefront/browseFilters";
import { hasDeal } from "../../lib/storefront/storeDeals";
import { deliveryEstimate } from "../../lib/driving/eta";
import { staggerContainer } from "../../lib/ui/motion";
import { POLL } from "../../lib/network/poll";
import { useClock } from "../../lib/hooks/useClock";
import { storeStatus } from "../../lib/storefront/storeHours";
import { useT } from "../../i18n";

interface Row {
  hash: Uint8Array;
  catalog: MerchantCatalog;
  rating: number;
  reviewCount: number;
}

interface BagRow {
  hash: Uint8Array;
  bag: GoodieBag;
}

// A restaurant that just published can take a while to become discoverable
// -- its GeohashToCatalog link has to reach whatever peer answers this
// read, not just the merchant's own chain (the project's own,
// long-documented DHT-propagation characteristic, roughly
// seconds-to-a-minute scale here, not instant). Without a poll, a customer
// already sitting on Browse when a merchant nearby publishes would see an
// empty list forever unless they happened to navigate away and back.
// Polled slowly (`POLL.slow`): stores open and close rarely.

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

  // Keyed by the browsing cell -- changing address drops any in-flight
  // reply for the old one instead of letting it overwrite the new list.
  const geohash = encodeGeohash(location.lat, location.lon);
  const { data: rows } = useResource<Row[]>(
    `browse-stores:${geohash}`,
    async () => {
      const page = await getNearbyMerchants(geohash);
      // Use `view.original_action`, never `actionHash(view.record)` -- the
      // record is resolved to this catalog's *latest* state, so its own
      // action hash drifts on every edit. See `CatalogView`'s own doc
      // comment. One bounded, checkpointed summary read per card -- this
      // store's own rating only, never the owner's other stores or their
      // driving (see `reputation_integrity`'s module doc).
      return Promise.all(
        page.catalogs.map(async (view) => {
          const catalog = decodeEntry<MerchantCatalog>(view.record);
          const summary = await getRatingSummary({ Store: view.original_action }).catch(() => ({ count: 0, rating_sum: 0, uncounted: 0 }));
          return { hash: view.original_action, catalog, rating: averageRating(summary) ?? 0, reviewCount: summary.count };
        }),
      );
    },
    { pollMs: POLL.slow },
  );
  // How long each store's food takes to drive here, by road -- one request
  // for the list, asked again only when the stores or the address change.
  const storesHex = rows?.map((r) => bytesToHex(r.hash)).join(",");
  const { data: driveMinutes } = useResource(
    rows ? `browse-drive:${location.lat},${location.lon}:${storesHex}` : null,
    async () => {
      const minutes = await minutesTo(location, rows!.map((r) => r.catalog.location));
      return new Map(rows!.map((r, i) => [bytesToHex(r.hash), minutes[i]]));
    },
  );
  // Expired bags are already filtered out server-side (and orders after the
  // window are rejected on-chain); filtering again here drops one that
  // closed since the last poll. `original_action` is the bag's identity --
  // what an order's line names.
  const { data: bags = [] } = useResource<BagRow[]>(
    `browse-bags:${geohash}`,
    async () => {
      const views = await getNearbyGoodieBags(geohash);
      const now = nowMicros();
      return views.map((v) => ({ hash: v.original_action, bag: decodeEntry<GoodieBag>(v.record) })).filter((r) => r.bag.pickup_window_end > now);
    },
    { pollMs: POLL.slow },
  );

  const catalogNameByHex = useMemo(() => {
    const map = new Map<string, string>();
    rows?.forEach((r) => map.set(bytesToHex(r.hash), r.catalog.business_name));
    return map;
  }, [rows]);

  // Asked only once someone's looking for deals: a read of each store's promos
  // and menu. A store with a goodie bag out has one already.
  const storesKeyHex = rows?.map((r) => bytesToHex(r.hash)).join(",");
  const { data: dealStores } = useResource(
    filters.deals && rows ? `browse-deals:${storesKeyHex}` : null,
    async () => {
      const at = new Date();
      const found = await Promise.all(rows!.map(async (r) => [bytesToHex(r.hash), await hasDeal(r.hash, r.catalog, at)] as const));
      return new Set(found.filter(([, deal]) => deal).map(([hex]) => hex));
    },
    { pollMs: POLL.slow },
  );
  const bagStores = useMemo(() => new Set(bags.map((row) => bytesToHex(row.bag.catalog_ref))), [bags]);

  const stores = useMemo(
    () =>
      rows?.map((row) => {
        const hex = bytesToHex(row.hash);
        const { catalog } = row;
        const estimate = deliveryEstimate(catalog, location, driveMinutes?.get(hex) ?? null);
        const facts: StoreFacts = {
          name: catalog.business_name,
          searchable: [catalog.business_name, catalog.cuisine_type, catalog.description, ...(catalog.dietary_tags ?? [])].join(" "),
          cuisine: catalog.cuisine_type,
          diets: catalog.dietary_tags ?? [],
          rating: row.rating,
          reviewCount: row.reviewCount,
          open: storeStatus(catalog, now).open,
          favorite: favoritesHex.has(hex),
          deal: bagStores.has(hex) || !!dealStores?.has(hex),
          minutes: estimate.toMinutes,
          km: estimate.km,
        };
        return { row, facts };
      }),
    [rows, location, driveMinutes, now, favoritesHex, bagStores, dealStores],
  );
  const filtered = useMemo(() => stores && applyFilters(stores, (store) => store.facts, filters), [stores, filters]);
  const options = (pick: (store: StoreFacts) => string[]) => [...new Set(stores?.flatMap((store) => pick(store.facts).filter(Boolean)))].sort();
  const lookingForDeals = filters.deals && dealStores === undefined;
  const narrowed = isNarrowed(filters);

  const openCount = (count: number) => (count === 0 ? t("browse.noneOpen") : t("browse.openCount", { count }));

  return (
    <div className="px-4 pt-4">
      <AddressSwitcher />

      <RecurringDue />

      <div className="mb-4 flex items-center gap-2 rounded-full border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 px-4 py-2.5 transition focus-within:border-handshake-400 focus-within:ring-2 focus-within:ring-handshake-100">
        <Search size={16} className="text-ink-400" />
        <input
          value={filters.query}
          onChange={(e) => setFilters({ ...filters, query: e.target.value })}
          placeholder={t("browse.search")}
          className="w-full bg-transparent text-sm outline-none"
        />
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
        {rows === undefined || filtered === null || filtered === undefined ? "…" : narrowed ? t("browse.matching", { count: filtered.length, total: rows.length }) : openCount(rows.filter((r) => storeStatus(r.catalog, now).open).length)}
      </p>

      {rows !== undefined && rows.length > 0 && (
        <BrowseFilterBar
          filters={filters}
          onChange={setFilters}
          cuisines={options((store) => [store.cuisine])}
          diets={options((store) => store.diets)}
          hasTimes={!!stores?.some((store) => store.facts.minutes !== null)}
          countWith={(patch) => stores?.filter((store) => matches(store.facts, { ...filters, ...patch })).length ?? 0}
        />
      )}

      {(rows === undefined || lookingForDeals) && (
        <div className="grid grid-cols-2 gap-3 pb-6 md:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      )}

      {rows !== undefined && rows.length === 0 && <EmptyState title={t("browse.emptyTitle")} subtitle={t("browse.emptySubtitle")} />}

      {rows !== undefined && rows.length > 0 && !lookingForDeals && filtered?.length === 0 && (
        <div className="pb-6">
          <EmptyState title={t("browse.noMatchTitle")} subtitle={t("browse.noMatchSubtitle")} />
          <Button variant="ghost" className="mx-auto -mt-8 block" onClick={() => setFilters(NO_FILTERS)}>{t("browse.filter.clear")}</Button>
        </div>
      )}

      {!lookingForDeals && filtered && filtered.length > 0 && (
        <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="grid grid-cols-2 gap-3 pb-6 md:grid-cols-3 xl:grid-cols-4">
          {filtered.map(({ row: r, facts }) => (
            <RestaurantCard
              key={bytesToHex(r.hash)}
              catalogHash={r.hash}
              catalog={r.catalog}
              now={now}
              rating={r.rating}
              reviewCount={r.reviewCount}
              customer={location}
              driveMinutes={driveMinutes?.get(bytesToHex(r.hash)) ?? null}
              favorited={facts.favorite}
              deal={filters.deals && facts.deal}
              onToggleFavorite={() => toggleFavorite(r.hash)}
            />
          ))}
        </motion.div>
      )}
    </div>
  );
}
