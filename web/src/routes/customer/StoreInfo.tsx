// Everything about a store that isn't its menu, a page of its own: reached by
// tapping the store's name on its menu.
import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowLeft, Clock, Star } from "lucide-react";
import { averageRating, getReviewsFor } from "../../holochain/zomes/reputation";
import { hexToBytes } from "../../holochain/decode";
import type { MerchantCatalog } from "../../holochain/types";
import { InfoSheet } from "../../components/InfoSheet";
import { StoreMap } from "../../components/places/StoreMap";
import { RatingCounted } from "../../components/store/RatingCounted";
import { ReviewList } from "../../components/store/ReviewList";
import { StoreContact } from "../../components/store/StoreContact";
import { Card, Skeleton } from "../../components/ui";
import { useClock } from "../../lib/hooks/useClock";
import { useGoBack } from "../../lib/hooks/useGoBack";
import { useResource } from "../../lib/hooks/useResource";
import { POLL } from "../../lib/network/poll";
import { storeStatus } from "../../lib/storefront/storeHours";
import { fetchStoreMenu, rememberedStoreMenu } from "../../lib/storefront/storePage";
import { formatCents } from "../../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { useT } from "../../i18n";
import { StoreRoute } from "./StoreRoute";
import { useStoreStanding } from "../../lib/hooks/useStoreStanding";

export function StoreInfo() {
  return <StoreRoute>{(hash) => <InfoPage key={hash} hash={hash} />}</StoreRoute>;
}

function InfoPage({ hash }: { hash: string }) {
  const t = useT();
  const routerState = useLocation().state as { catalog?: MerchantCatalog } | null;
  const catalogHash = useMemo(() => hexToBytes(hash), [hash]);
  const goBack = useGoBack(`/customer/merchant/${hash}`);
  const { data: fresh } = useResource(`store-menu:${hash}`, () => fetchStoreMenu(hash, catalogHash), { pollMs: POLL.slow });
  const catalog = fresh?.catalog ?? rememberedStoreMenu(hash)?.catalog ?? routerState?.catalog ?? null;
  const { rating, record } = useStoreStanding(hash, catalogHash);
  const now = useClock();

  if (!catalog) {
    return (
      <div className="px-4 pt-4 lg:px-0">
        <Skeleton className="mb-4 h-36 w-full" />
        <Skeleton className="mb-2 h-7 w-2/3" />
        <Skeleton className="mb-6 h-4 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const status = storeStatus(catalog, now);
  const avgRating = rating ? averageRating(rating) : null;
  const prepMinutes = catalog.prep_minutes + catalog.busy_extra_minutes;
  const recordLines = [
    record && record.late_count > 0 && t("store.late", { count: record.late_count }),
    record && record.check_in_refused_count > 0 && t("store.reports", { count: record.check_in_refused_count }),
    record && record.cancelled_by_them_count > 0 && t("store.calledOff", { count: record.cancelled_by_them_count }),
  ].filter((line): line is string => !!line);
  const recordSections = (["what", "who", "money"] as const).map((part) => ({ title: t(`storeInfo.record.${part}`), body: t(`storeInfo.record.${part}Detail`) }));

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="pb-24 lg:pb-8">
      <div className="relative h-36 overflow-hidden md:h-44 lg:rounded-3xl">
        {catalog.banner_data_uri ? (
          <img src={catalog.banner_data_uri} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center bg-gradient-to-br from-handshake-400 to-handshake-600 text-5xl">🍽️</div>
        )}
        <div aria-hidden className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/25 to-transparent" />
        <motion.button whileTap={{ scale: 0.9 }} onClick={goBack} aria-label={t("common.back")} className="absolute top-3 left-3 grid h-10 w-10 place-items-center rounded-full bg-white/90 shadow backdrop-blur-sm transition hover:bg-white lg:top-4 lg:left-4">
          <ArrowLeft size={18} className="text-ink-900" />
        </motion.button>
      </div>

      <div className="px-4 pt-4 lg:px-0 lg:pt-6">
        <motion.div variants={fadeSlideUp}>
          <h1 className="text-2xl font-black tracking-tight text-ink-900 lg:text-3xl dark:text-ink-50">{catalog.business_name}</h1>
          {catalog.cuisine_type && <p className="mt-0.5 text-sm text-ink-400">{catalog.cuisine_type}</p>}
          {catalog.description && <p className="mt-3 text-sm leading-relaxed text-ink-600 dark:text-ink-300">{catalog.description}</p>}
        </motion.div>

        <motion.div variants={fadeSlideUp} className="mt-5 grid grid-cols-2 gap-3">
          <Card className="p-4">
            <p className="flex items-center gap-1 text-2xl font-black text-ink-900 dark:text-ink-50">
              {avgRating !== null ? avgRating.toFixed(1) : "–"}
              <Star size={18} className="fill-amber-400 text-amber-400" />
            </p>
            <p className="mt-1 text-xs text-ink-400">{avgRating !== null && rating ? t("storeInfo.ratings", { count: rating.count }) : t("storeInfo.noRatings")}</p>
          </Card>
          <Card className="p-4">
            <p className={status.open ? "flex items-center gap-1.5 text-sm font-bold text-presence-600" : "flex items-center gap-1.5 text-sm font-bold text-red-500"}>
              <Clock size={15} /> {status.label}
            </p>
            <p className="mt-1.5 text-xs text-ink-400">{t("storeInfo.prep", { minutes: prepMinutes })}</p>
            {catalog.min_order_cents !== null && <p className="text-xs text-ink-400">{t("store.minimum", { amount: formatCents(catalog.min_order_cents) })}</p>}
          </Card>
        </motion.div>

        {recordLines.length > 0 && (
          <motion.section variants={fadeSlideUp} className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/30">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold text-amber-900 dark:text-amber-200"><AlertTriangle size={15} /> {t("storeInfo.record")}</h2>
              <InfoSheet title={t("storeInfo.record.how")} sections={recordSections} />
            </div>
            <ul className="mt-2 flex flex-col gap-1 text-xs font-medium text-amber-900/80 dark:text-amber-200/80">
              {recordLines.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </motion.section>
        )}

        <motion.div variants={fadeSlideUp} className="mt-5">
          <StoreMap location={catalog.location} />
        </motion.div>
        <motion.div variants={fadeSlideUp}>
          <StoreContact catalog={catalog} />
        </motion.div>

        <motion.div variants={fadeSlideUp}>
          {rating && <RatingCounted rating={rating} />}
          <ReviewList className="mt-6" feedKey={`store:${hash}`} fetchPage={(before) => getReviewsFor({ Store: catalogHash }, before)} />
        </motion.div>
      </div>
    </motion.div>
  );
}
