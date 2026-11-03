import { useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Clock, Heart, Info, ShoppingBag } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getCatalog, listGoodieBagsForCatalog, storeSuccessor } from "../../holochain/zomes/catalog";
import { averageRating, getRatingSummary, getReputationSummary, getReviewsFor, getItemRatingSummary, type ItemRatingSummary } from "../../holochain/zomes/reputation";
import { useResource } from "../../lib/hooks/useResource";
import { decodeEntry, hexToBytes, bytesToHex } from "../../holochain/decode";
import { useCart } from "../../store/cart";
import { formatCents, nowMicros } from "../../lib/ui/format";
import { Chip, ChipRow, Skeleton } from "../../components/ui";
import { useTerms } from "../../store/network";
import { useT } from "../../i18n";
import { StoreContact } from "../../components/store/StoreContact";
import { StarRating } from "../../components/StarRating";
import { StoreRewardsStrip } from "./Rewards";
import { StoreDeals } from "../../components/store/Deals";
import { ItemSheet } from "../../components/store/ItemSheet";
import { MenuItemCard } from "../../components/store/MenuItemCard";
import { MenuCategoryNav } from "../../components/store/MenuCategoryNav";
import { StoreBags } from "../../components/store/StoreBags";
import { bagLine, type BagRow } from "../../lib/storefront/bags";
import { StoreCartPanel } from "../../components/store/StoreCartPanel";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { fetchMenu, groupByCategory } from "../../lib/storefront/menu";
import { useFavorites } from "../../lib/hooks/useFavorites";
import type { ItemRow } from "../../lib/storefront/menu";
import type { GoodieBag, MerchantCatalog } from "../../holochain/types";
import { POLL } from "../../lib/network/poll";
import { useClock } from "../../lib/hooks/useClock";
import { storeStatus } from "../../lib/storefront/storeHours";
import { ReviewList } from "../../components/store/ReviewList";

/// Polled for the same reason Browse.tsx's list is -- a menu item added
/// moments ago may not have gossiped to whatever peer answers this read
/// yet, and a customer already sitting on this page shouldn't need to
/// navigate away and back for it to show up.

interface StoreMenu {
  catalog: MerchantCatalog;
  items: ItemRow[];
  bags: BagRow[];
}

async function fetchStoreMenu(catalogHash: Uint8Array): Promise<StoreMenu> {
  const [record, items, bagViews] = await Promise.all([getCatalog(catalogHash), fetchMenu(catalogHash), listGoodieBagsForCatalog(catalogHash)]);
  // Same as Browse.tsx's strip: drops a bag that closed since the last poll.
  const now = nowMicros();
  return {
    catalog: decodeEntry<MerchantCatalog>(record),
    items,
    bags: bagViews.map((v) => ({ hash: v.original_action, bag: decodeEntry<GoodieBag>(v.record) })).filter((r) => r.bag.pickup_window_end > now),
  };
}

/// Keyed by the store in the URL, so moving from one store page to another
/// mounts a fresh page -- no state (reviews, claim forms, filters) can carry
/// over from the previous store.
export function MerchantDetail() {
  const { hash } = useParams<{ hash: string }>();
  // A store its owner moved to a new key (a new phone) sends customers on
  // to the new one -- a saved favourite, an old link.
  const { data: movedTo } = useResource(hash ? `store-successor:${hash}` : null, () => storeSuccessor(hexToBytes(hash!)));
  if (!hash) return null;
  if (movedTo) return <Navigate to={`/customer/merchant/${bytesToHex(movedTo)}`} replace />;
  return <StorePage key={hash} hash={hash} />;
}

function StorePage({ hash }: { hash: string }) {
  const navigate = useNavigate();
  const minAge = useTerms().restricted_min_age;
  const t = useT();
  // A card click passes the catalog it already has, so the header renders
  // instantly; the fetch below replaces it with the live version (and is
  // the only source when arriving via a direct URL/refresh).
  const routerState = useLocation().state as { catalog?: MerchantCatalog } | null;
  const cart = useCart();
  const catalogHash = useMemo(() => hexToBytes(hash), [hash]);
  const { data: menu } = useResource(`store-menu:${hash}`, () => fetchStoreMenu(catalogHash), { pollMs: POLL.slow });
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
  // This store's own rating and reviews -- keyed by the store, not its
  // owner, so a multi-store owner's other locations (or their driving)
  // never bleed into this page.
  const { data: rating } = useResource(`store-rating:${hash}`, () => getRatingSummary({ Store: catalogHash }));
  // How it treats drivers: times it kept one waiting (each refunded its
  // customer), and drivers' reports it wouldn't check them in.
  const { data: record = null } = useResource(`store-record:${hash}`, () => getReputationSummary({ Store: catalogHash }));
  const { favoritesHex, toggleFavorite } = useFavorites();
  const favorited = favoritesHex.has(hash);
  const [dietaryFilter, setDietaryFilter] = useState<string[]>([]);
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
        <motion.button whileTap={{ scale: 0.9 }} onClick={() => navigate(-1)} aria-label={t("common.back")} className="absolute top-3 left-3 grid h-10 w-10 place-items-center rounded-full bg-white/90 shadow backdrop-blur-sm transition hover:bg-white lg:top-4 lg:left-4">
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
        <motion.h1 variants={fadeSlideUp} className="text-2xl font-black tracking-tight text-ink-900 lg:text-3xl dark:text-ink-50">{catalog.business_name}</motion.h1>
        {catalog.description && <p className="mt-1 max-w-2xl text-sm text-ink-500 lg:text-base">{catalog.description}</p>}

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-400 lg:text-sm">
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
          {catalog.min_order_cents !== null && <span>{t("store.minimum", { amount: formatCents(catalog.min_order_cents) })}</span>}
          <button
            type="button"
            onClick={() => document.getElementById("store-contact")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="flex items-center gap-1 font-semibold text-handshake-600 hover:text-handshake-700 dark:text-handshake-400"
          >
            <Info size={12} /> {t("storeContact.jump")}
          </button>
        </div>

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
                    <Chip key={tag} active={dietaryFilter.includes(tag)} onClick={() => setDietaryFilter((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))} tone="brand">
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

            <motion.div variants={fadeSlideUp}>
              <StoreContact catalog={catalog} />
            </motion.div>

            <motion.div variants={fadeSlideUp}>
              <ReviewList className="mt-6" feedKey={`store:${hash}`} fetchPage={(before) => getReviewsFor({ Store: catalogHash }, before)} />
            </motion.div>
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
