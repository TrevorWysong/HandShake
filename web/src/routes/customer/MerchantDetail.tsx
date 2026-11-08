import { useMemo, useState } from "react";
import { LoadProblem } from "../../components/LoadProblem";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronRight, Clock, Heart, HeartPulse, Tag } from "lucide-react";
import { motion } from "framer-motion";
import clsx from "clsx";
import { averageRating, getItemRatingSummaries, type ItemRatingSummary } from "../../holochain/zomes/reputation";
import { useResource } from "../../lib/hooks/useResource";
import { useGoBack } from "../../lib/hooks/useGoBack";
import { soldRow } from "../../lib/storefront/sales";
import { useMyAllergies } from "../../lib/hooks/useMyAllergies";
import { hasAllergies, honestTags, matchAllergies, needsALook } from "../../lib/storefront/allergens";
import { useAllergenNames } from "../../lib/hooks/useAllergenNames";
import { hexToBytes, bytesToHex } from "../../holochain/decode";
import { useCart, type CartLine } from "../../store/cart";
import { useCartSwitch } from "../../lib/hooks/useCartSwitch";
import { NewCartSheet } from "../../components/store/NewCartSheet";
import { formatCents } from "../../lib/ui/format";
import { Chip, ChipRow, Skeleton } from "../../components/ui";
import { useTerms } from "../../store/network";
import { useT } from "../../i18n";
import { StarRating } from "../../components/StarRating";
import { StoreRewardsStrip } from "./Rewards";
import { StoreDeals } from "../../components/store/Deals";
import { ItemSheet } from "../../components/store/ItemSheet";
import { MenuItemCard } from "../../components/store/MenuItemCard";
import { MenuCategoryNav } from "../../components/store/MenuCategoryNav";
import { StoreBags } from "../../components/store/StoreBags";
import { bagLine } from "../../lib/storefront/bags";
import { StoreCartPanel } from "../../components/store/StoreCartPanel";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { groupByCategory } from "../../lib/storefront/menu";
import { fetchStoreMenu, rememberedStoreMenu } from "../../lib/storefront/storePage";
import { useFavorites } from "../../lib/hooks/useFavorites";
import type { ItemRow } from "../../lib/storefront/menu";
import type { MerchantCatalog } from "../../holochain/types";
import { POLL } from "../../lib/network/poll";
import { useClock } from "../../lib/hooks/useClock";
import { storeStatus } from "../../lib/storefront/storeHours";
import { StoreRoute } from "./StoreRoute";
import { useStoreStanding } from "../../lib/hooks/useStoreStanding";

/// Keyed by the store in the URL, so moving from one store page to another
/// mounts a fresh page -- no state (claim forms, filters) can carry over from
/// the previous store.
export function MerchantDetail() {
  return <StoreRoute>{(hash) => <StorePage key={hash} hash={hash} />}</StoreRoute>;
}

function StorePage({ hash }: { hash: string }) {
  const goBack = useGoBack("/customer");
  const minAge = useTerms().restricted_min_age;
  const t = useT();
  // A card click passes the catalog it already has, so the header renders
  // instantly; the fetch below replaces it with the live version (and is
  // the only source when arriving via a direct URL/refresh).
  const routerState = useLocation().state as { catalog?: MerchantCatalog } | null;
  const cart = useCart();
  const catalogHash = useMemo(() => hexToBytes(hash), [hash]);
  // Polled for the same reason Browse.tsx's list is -- a menu item added
  // moments ago may not have gossiped to whatever peer answers this read yet,
  // and a customer already on this page shouldn't need to leave and come back.
  const { data: fresh, error: menuError, reload: reloadMenu } = useResource(`store-menu:${hash}`, () => fetchStoreMenu(hash, catalogHash), { pollMs: POLL.slow });
  const menu = fresh ?? rememberedStoreMenu(hash);
  const catalog = menu?.catalog ?? routerState?.catalog ?? null;
  const now = useClock();
  const status = catalog ? storeStatus(catalog, now) : null;
  // As they sell right now: a sale's price, while it's running.
  const items = menu && catalog ? menu.items.map((row) => soldRow(row, catalog, now)) : null;
  const bags = menu?.bags ?? [];
  // Read together, a batch per call. Keyed by the exact item set, so a newly
  // added item gets its rating read too.
  const itemsKey = items ? `item-ratings:${items.map((row) => bytesToHex(row.hash)).join(",")}` : null;
  const { data: itemRatings = {} } = useResource<Record<string, ItemRatingSummary>>(itemsKey, async () => {
    const rows = items ?? [];
    const summaries = await getItemRatingSummaries(rows.map((row) => row.hash)).catch(() => []);
    return Object.fromEntries(summaries.map((summary, i) => [bytesToHex(rows[i].hash), summary]));
  });
  const { rating, record } = useStoreStanding(hash, catalogHash);
  const { mine } = useMyAllergies();
  const allergenNames = useAllergenNames();
  const { favoritesHex, toggleFavorite } = useFavorites();
  const favorited = favoritesHex.has(hash);
  // In the URL, so it's still set on coming back from the store's info page.
  const [params, setParams] = useSearchParams();
  const dietaryFilter = useMemo(() => params.getAll("diet"), [params]);
  const toggleDiet = (tag: string) => setFilters(dietaryFilter.includes(tag) ? dietaryFilter.filter((t) => t !== tag) : [...dietaryFilter, tag], hideMatches);
  /// The item whose choices are open, if any.
  const [choosing, setChoosing] = useState<ItemRow | null>(null);
  const cartSwitch = useCartSwitch();

  // Scoped to this one restaurant's own menu, not a union across every
  // nearby restaurant -- a per-merchant menu is naturally small and bounded,
  // unlike the metro-area-wide tag set a Browse-screen version of this
  // filter would have to show (see MerchantCatalog.dietary_tags' own doc
  // comment: that field exists for a different purpose, denormalized
  // discovery-level signal, not this screen's filter). Kept above the
  // loading early-return below -- hooks after it would only run once
  // `items` loads, changing the hook count between renders and crashing.
  const dietaryTags = [...new Set((items ?? []).flatMap((row) => honestTags(row.item.dietary_tags ?? [], row.item.allergens)))].sort();
  // Hiding only ever hides what a store says contains them: what it hasn't
  // said stays, flagged, so nothing reads as cleared by being left in.
  const hideMatches = params.get("hide") === "1";
  const filteredItems = (items ?? []).filter((row) => {
    if (dietaryFilter.length > 0 && !dietaryFilter.some((tag) => honestTags(row.item.dietary_tags ?? [], row.item.allergens).includes(tag))) return false;
    if (!hideMatches) return true;
    const match = matchAllergies(row.item.allergens, null, mine);
    return match.contains.length === 0 && match.containsOther.length === 0;
  });
  // Filtered too: what someone's asked not to see stays out of the sale as well.
  const onSale = filteredItems.filter((row) => row.fullPriceCents && row.item.available);
  const setFilters = (diet: string[], hide: boolean) => setParams({ ...(diet.length ? { diet } : {}), ...(hide ? { hide: "1" } : {}) }, { replace: true });

  if (!catalog || !items) {
    if (menuError) return <LoadProblem error={menuError} onRetry={reloadMenu} />;
    return (
      <div className="pb-24">
        <Skeleton className="h-44 w-full rounded-none md:h-56 lg:h-64 lg:rounded-3xl" />
        <div className="px-4 pt-4 lg:px-0 lg:pt-6">
          <Skeleton className="mb-2 h-7 w-2/3 max-w-sm" />
          <Skeleton className="mb-6 h-4 w-1/3 max-w-48" />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        </div>
      </div>
    );
  }

  /// Into the cart -- asked first if it holds another store's order.
  const addLine = (line: CartLine) => cartSwitch.ask(catalogHash, () => cart.addLine(catalogHash, catalog.owner, catalog.business_name, line));
  /// An item without choices goes straight in the cart; one with choices
  /// opens its sheet.
  const addItem = (row: ItemRow) => {
    // Choices to make, or something to read first: someone's allergies, or a
    // store's silence, is worth a look before it's in the cart.
    if (row.item.modifier_groups.length > 0 || needsALook(matchAllergies(row.item.allergens, catalog.allergy_policy, mine))) {
      setChoosing(row);
      return;
    }
    const { hash: itemRef, item } = row;
    addLine({ itemRef, name: item.name, basePriceCents: item.price_cents, priceCents: item.price_cents, choiceCharges: [], quantity: 1, selections: [], choiceLabels: [] });
  };
  const avgRating = rating ? averageRating(rating) : null;
  const grouped = groupByCategory(filteredItems);
  const groupedCategories = [...grouped.keys()].map((name, i) => ({ id: `menu-${i}`, name }));
  const categories = onSale.length > 0 ? [{ id: "menu-sale", name: t("store.onSale") }, ...groupedCategories] : groupedCategories;
  // One category leaves nothing to jump between, and the menu takes its room.
  const browsable = categories.length > 1;
  const itemGrid = clsx("grid grid-cols-1 gap-3 md:grid-cols-2", browsable && "lg:grid-cols-1 xl:grid-cols-2");

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pb-24 lg:pb-8">
      <div className="relative h-44 overflow-hidden md:h-56 lg:h-64 lg:rounded-3xl">
        {catalog.banner_data_uri ? (
          <img src={catalog.banner_data_uri} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center bg-gradient-to-br from-handshake-400 to-handshake-600 text-6xl">🍽️</div>
        )}
        <div aria-hidden className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/25 to-transparent" />
        <motion.button whileTap={{ scale: 0.9 }} onClick={goBack} aria-label={t("common.back")} className="absolute top-3 left-3 grid h-10 w-10 place-items-center rounded-full bg-white/90 shadow backdrop-blur-sm transition hover:bg-white lg:top-4 lg:left-4">
          <ArrowLeft size={18} className="text-ink-900" />
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={() => toggleFavorite(catalogHash)}
          aria-label={t(favorited ? "store.unfavorite" : "store.favorite")}
          aria-pressed={favorited}
          className="absolute top-3 right-3 grid h-10 w-10 place-items-center rounded-full bg-white/90 shadow backdrop-blur-sm transition hover:bg-white lg:top-4 lg:right-4"
        >
          <Heart size={18} className="text-red-500" fill={favorited ? "currentColor" : "none"} />
        </motion.button>
      </div>

      <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4 lg:px-0 lg:pt-6">
        {/* The way to everything about the store: its reviews, hours, address and record. */}
        <motion.div variants={fadeSlideUp}>
          <Link to={`/customer/merchant/${hash}/about`} state={{ catalog }} aria-label={t("store.infoFor", { store: catalog.business_name })} className="group -m-2 block rounded-2xl p-2 transition-colors hover:bg-ink-100/70 active:bg-ink-100 dark:hover:bg-ink-800/50 dark:active:bg-ink-800">
            <span className="flex items-center justify-between gap-3">
              <h1 className="min-w-0 text-2xl font-black tracking-tight text-ink-900 lg:text-3xl dark:text-ink-50">{catalog.business_name}</h1>
              <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-500 transition group-hover:translate-x-0.5 group-hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-300 dark:group-hover:bg-ink-700">
                <ChevronRight size={18} />
              </span>
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-400 lg:text-sm">
              {avgRating !== null && rating && <StarRating value={avgRating} count={rating.count} />}
              <span className={status?.open ? "flex items-center gap-1 font-semibold text-presence-600" : "flex items-center gap-1 font-semibold text-red-500"}>
                <Clock size={12} />
                {status?.label}
              </span>
              {/* Closed for now, but taking orders: one can be scheduled for when it opens. */}
              {catalog.is_open && status && !status.open && <span className="font-semibold text-ink-500 dark:text-ink-300">{t("store.orderAhead")}</span>}
              {catalog.cuisine_type && <span>{catalog.cuisine_type}</span>}
              {catalog.busy_extra_minutes > 0 && <span className="font-semibold text-amber-600">{t("store.busy", { minutes: catalog.prep_minutes + catalog.busy_extra_minutes })}</span>}
              {record && record.late_count > 0 && <span className="font-semibold text-amber-600">{t("store.late", { count: record.late_count })}</span>}
              {record && record.check_in_refused_count > 0 && <span className="font-semibold text-amber-600">{t("store.reports", { count: record.check_in_refused_count })}</span>}
              {record && record.cancelled_by_them_count > 0 && <span className="font-semibold text-amber-600">{t("store.calledOff", { count: record.cancelled_by_them_count })}</span>}
              {catalog.min_order_cents !== null && <span>{t("store.minimum", { amount: formatCents(catalog.min_order_cents) })}</span>}
            </span>
            <span className="mt-1.5 block text-xs font-semibold text-handshake-600 lg:text-sm dark:text-handshake-400">{t("store.info")}</span>
          </Link>
        </motion.div>

        {hash && <StoreRewardsStrip catalogHex={hash} />}
        {hash && <StoreDeals catalogHex={hash} menu={items ?? []} />}
        <StoreBags bags={bags} onAdd={(row) => addLine(bagLine(row))} />

        {/* The menu: categories beside it and the cart beside that, as the window allows. */}
        <div className={clsx("mt-6 lg:grid lg:gap-8", browsable ? "lg:grid-cols-[11rem_minmax(0,1fr)] 2xl:grid-cols-[11rem_minmax(0,1fr)_18rem]" : "lg:grid-cols-[minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_18rem]")}>
          {browsable && (
            <div className="hidden lg:block">
              <MenuCategoryNav categories={categories} placement="side" label={t("store.categories")} />
            </div>
          )}

          <div className="min-w-0">
            {browsable && <MenuCategoryNav categories={categories} placement="bar" label={t("store.categories")} className="lg:hidden" />}

            <p className="mt-4 text-xs text-ink-500 lg:mt-0 lg:mb-3 dark:text-ink-400">{t("store.allergyNotice")}</p>
            {hasAllergies(mine) && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-handshake-50 px-3 py-2 lg:mt-0 lg:mb-3 dark:bg-handshake-500/15">
                <Link to="/profile" className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-handshake-800 dark:text-handshake-200">
                  <HeartPulse size={14} className="shrink-0" />
                  <span className="truncate">{t("store.flagging", { allergens: [allergenNames(mine.allergens), ...mine.other].filter(Boolean).join(", ") })}</span>
                </Link>
                <Chip active={hideMatches} onClick={() => setFilters(dietaryFilter, !hideMatches)} tone="brand">{t("store.hideMatches")}</Chip>
              </div>
            )}

            {hideMatches && <p className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-200">{t("store.hiddenNote")}</p>}

            {dietaryTags.length > 0 && (
              <div className="mt-4 flex items-center gap-2 lg:mt-0">
                <span className="shrink-0 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">{t("store.diet")}</span>
                <ChipRow>
                  {dietaryTags.map((tag) => (
                    <Chip key={tag} active={dietaryFilter.includes(tag)} onClick={() => toggleDiet(tag)} tone="brand">
                      {tag}
                    </Chip>
                  ))}
                </ChipRow>
              </div>
            )}

            {onSale.length > 0 && (
              <section id="menu-sale" className="mt-4 scroll-mt-32 rounded-2xl bg-handshake-50 p-3 lg:scroll-mt-6 dark:bg-handshake-500/10">
                <h2 className="mb-3 flex items-center gap-1.5 text-lg font-bold tracking-tight text-ink-900 dark:text-ink-50"><Tag size={17} className="text-handshake-500" /> {t("store.onSale")}</h2>
                <div className={itemGrid}>
                  {onSale.map((row) => (
                    <MenuItemCard key={bytesToHex(row.hash)} row={row} rating={itemRatings[bytesToHex(row.hash)]} minAge={minAge} canAdd={row.item.available && catalog.is_open} match={matchAllergies(row.item.allergens, catalog.allergy_policy, mine)} store={catalog} now={now} onAdd={() => addItem(row)} />
                  ))}
                </div>
              </section>
            )}

            {[...grouped.entries()].map(([category, rows], i) => (
              <section key={category} id={groupedCategories[i].id} className="mt-6 scroll-mt-32 first:mt-4 lg:scroll-mt-6">
                <h2 className="mb-3 text-lg font-bold tracking-tight text-ink-900 dark:text-ink-50">{category}</h2>
                {/* One column on a phone; two on a tablet, or a wide screen with room beside any categories. */}
                <div className={itemGrid}>
                  {rows.map((row) => (
                    <MenuItemCard key={bytesToHex(row.hash)} row={row} rating={itemRatings[bytesToHex(row.hash)]} minAge={minAge} canAdd={row.item.available && catalog.is_open} match={matchAllergies(row.item.allergens, catalog.allergy_policy, mine)} store={catalog} now={now} onAdd={() => addItem(row)} />
                  ))}
                </div>
              </section>
            ))}

            {items.length === 0 && <p className="mt-6 rounded-2xl border border-ink-100 bg-white p-6 text-center text-sm text-ink-400 dark:border-ink-800 dark:bg-ink-900">{t("store.noMenu")}</p>}
            {items.length > 0 && filteredItems.length === 0 && (
              <div className="mt-6 rounded-2xl border border-ink-100 bg-white p-6 text-center dark:border-ink-800 dark:bg-ink-900">
                <p className="text-sm text-ink-400">{t("store.noneMatch")}</p>
                <button onClick={() => setFilters([], false)} className="mt-2 text-sm font-semibold text-handshake-600 dark:text-handshake-400">
                  {t("store.showAll")}
                </button>
              </div>
            )}
          </div>

          <div className="hidden 2xl:block">
            <StoreCartPanel catalogRef={catalogHash} />
          </div>
        </div>
      </motion.div>

      {choosing && (
        <ItemSheet
          key={bytesToHex(choosing.hash)}
          catalogRef={catalogHash}
          row={choosing}
          policy={catalog.allergy_policy}
          onClose={() => setChoosing(null)}
          onDone={(line) => {
            setChoosing(null);
            addLine(line);
          }}
        />
      )}
      <NewCartSheet pending={cartSwitch.pending} onConfirm={cartSwitch.confirm} onCancel={cartSwitch.cancel} />
    </motion.div>
  );
}
