import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronRight, Clock, Heart, ShoppingBag } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { averageRating, getItemRatingSummary, type ItemRatingSummary } from "../../holochain/zomes/reputation";
import { useResource } from "../../lib/hooks/useResource";
import { useGoBack } from "../../lib/hooks/useGoBack";
import { hexToBytes, bytesToHex } from "../../holochain/decode";
import { useCart } from "../../store/cart";
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
  const navigate = useNavigate();
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
  const { data: fresh } = useResource(`store-menu:${hash}`, () => fetchStoreMenu(hash, catalogHash), { pollMs: POLL.slow });
  const menu = fresh ?? rememberedStoreMenu(hash);
  const catalog = menu?.catalog ?? routerState?.catalog ?? null;
  const now = useClock();
  const status = catalog ? storeStatus(catalog, now) : null;
  const items = menu?.items ?? null;
  const bags = menu?.bags ?? [];
  // Bounded by the menu page itself (a merchant's own menu, already capped
  // -- see list_menu_items' own pagination). Keyed by the exact item set,
  // so a newly added item gets its rating read too.
  const itemsKey = items ? `item-ratings:${items.map((row) => bytesToHex(row.hash)).join(",")}` : null;
  const { data: itemRatings = {} } = useResource<Record<string, ItemRatingSummary>>(itemsKey, async () => {
    const entries = await Promise.all(
      (items ?? []).map(async (row) => [bytesToHex(row.hash), await getItemRatingSummary(row.hash).catch(() => ({ count: 0, rating_sum: 0 }))] as const),
    );
    return Object.fromEntries(entries);
  });
  const { rating, record } = useStoreStanding(hash, catalogHash);
  const { favoritesHex, toggleFavorite } = useFavorites();
  const favorited = favoritesHex.has(hash);
  // In the URL, so it's still set on coming back from the store's info page.
  const [params, setParams] = useSearchParams();
  const dietaryFilter = useMemo(() => params.getAll("diet"), [params]);
  const toggleDiet = (tag: string) => setParams({ diet: dietaryFilter.includes(tag) ? dietaryFilter.filter((t) => t !== tag) : [...dietaryFilter, tag] }, { replace: true });
  /// The item whose choices are open, if any.
  const [choosing, setChoosing] = useState<ItemRow | null>(null);

  // Scoped to this one restaurant's own menu, not a union across every
  // nearby restaurant -- a per-merchant menu is naturally small and bounded,
  // unlike the metro-area-wide tag set a Browse-screen version of this
  // filter would have to show (see MerchantCatalog.dietary_tags' own doc
  // comment: that field exists for a different purpose, denormalized
  // discovery-level signal, not this screen's filter). Kept above the
  // loading early-return below -- hooks after it would only run once
  // `items` loads, changing the hook count between renders and crashing.
  const dietaryTags = useMemo(() => {
    const set = new Set<string>();
    items?.forEach((row) => (row.item.dietary_tags ?? []).forEach((t) => set.add(t)));
    return [...set].sort();
  }, [items]);
  const filteredItems = useMemo(() => {
    if (dietaryFilter.length === 0) return items ?? [];
    return (items ?? []).filter((row) => dietaryFilter.some((tag) => (row.item.dietary_tags ?? []).includes(tag)));
  }, [items, dietaryFilter]);

  if (!catalog || !items) {
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

  const cartCount = cart.lines.reduce((n, l) => n + l.quantity, 0);
  /// An item without choices goes straight in the cart; one with choices
  /// opens its sheet.
  const addItem = (row: ItemRow) => {
    if (row.item.modifier_groups.length > 0) {
      setChoosing(row);
      return;
    }
    const { hash: itemRef, item } = row;
    cart.addLine(catalogHash, catalog.owner, catalog.business_name, { itemRef, name: item.name, basePriceCents: item.price_cents, priceCents: item.price_cents, choiceCharges: [], quantity: 1, selections: [], choiceLabels: [] });
  };
  const avgRating = rating ? averageRating(rating) : null;
  const grouped = groupByCategory(filteredItems);
  const categories = [...grouped.keys()].map((name, i) => ({ id: `menu-${i}`, name }));

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
        <StoreBags bags={bags} onAdd={(row) => cart.addLine(catalogHash, catalog.owner, catalog.business_name, bagLine(row))} />

        {/* The menu: categories beside it and the cart beside that, as the window allows. */}
        <div className="mt-6 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8 2xl:grid-cols-[11rem_minmax(0,1fr)_18rem]">
          <div className="hidden lg:block">
            <MenuCategoryNav categories={categories} placement="side" label={t("store.categories")} />
          </div>

          <div className="min-w-0">
            <MenuCategoryNav categories={categories} placement="bar" label={t("store.categories")} className="lg:hidden" />

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

            {[...grouped.entries()].map(([category, rows], i) => (
              <section key={category} id={categories[i].id} className="mt-6 scroll-mt-32 first:mt-4 lg:scroll-mt-6">
                <h2 className="mb-3 text-lg font-bold tracking-tight text-ink-900 dark:text-ink-50">{category}</h2>
                {/* One column on a phone; two on a tablet, or a wide screen with room beside the categories. */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  {rows.map((row) => (
                    <MenuItemCard key={bytesToHex(row.hash)} row={row} rating={itemRatings[bytesToHex(row.hash)]} minAge={minAge} canAdd={row.item.available && catalog.is_open} onAdd={() => addItem(row)} />
                  ))}
                </div>
              </section>
            ))}

            {items.length === 0 && <p className="mt-6 rounded-2xl border border-ink-100 bg-white p-6 text-center text-sm text-ink-400 dark:border-ink-800 dark:bg-ink-900">{t("store.noMenu")}</p>}
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
          onClose={() => setChoosing(null)}
          onDone={(line) => {
            cart.addLine(catalogHash, catalog.owner, catalog.business_name, line);
            setChoosing(null);
          }}
        />
      )}

      {/* The cart, until the window has room to show it beside the menu. */}
      <AnimatePresence>
        {cartCount > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 30 }}
            className="fixed inset-x-0 bottom-20 z-20 mx-auto flex max-w-md justify-center px-4 lg:bottom-6 lg:left-sidebar 2xl:hidden"
          >
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={() => navigate("/customer/cart")}
              className="flex w-full items-center justify-between rounded-full bg-handshake-500 px-5 py-3.5 font-semibold text-white shadow-[var(--shadow-glow)] transition hover:bg-handshake-600"
            >
              <span className="flex items-center gap-2">
                <ShoppingBag size={18} />
                {t("store.viewCart")} · {t("orders.items", { count: cartCount })}
              </span>
              <span>{formatCents(cart.total())}</span>
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
