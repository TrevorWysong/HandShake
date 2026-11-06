import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { BarChart3, Clock, Landmark, Store as StoreIcon, Truck, type LucideIcon } from "lucide-react";
import clsx from "clsx";
import { setCatalogOpen } from "../../holochain/zomes/catalog";
import { averageRating, getRatingSummary } from "../../holochain/zomes/reputation";
import { useMerchantStores } from "../../store/merchantStores";
import { useResource } from "../../lib/hooks/useResource";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { GroupHeading, Notice, Switch } from "../../components/ui";
import { StarRating } from "../../components/StarRating";
import { StoreSwitcher } from "../../components/store/StoreSwitcher";
import { GettingPaidCard } from "../../components/payments/GettingPaidCard";
import { InsightsCard } from "./catalog/InsightsCard";
import { TaxCard, TaxReportCard } from "./catalog/TaxCard";
import { AutoAcceptCard, BusyCard, DeliverySubsidyCard, LeaveAtDoorCard, ListingCard, MinimumOrderCard, StoreDetailsCard, StoreWaitCard, TipLimitCard } from "./catalog/StoreDetailsCard";
import { HoursCard } from "./catalog/HoursCard";
import { AllergyPolicyCard } from "./catalog/AllergyPolicyCard";
import { StoreReviews } from "./catalog/StoreReviews";
import { ForActiveStore, StoreSkeleton } from "./ActiveStore";
import { useStore } from "./useStore";
import { useT } from "../../i18n";
import { toast } from "../../store/toast";
import { useAction } from "../../lib/hooks/useAction";

/// The Store tab: how the active store runs -- whether it's taking orders,
/// its storefront, where it's paid and its tax, how orders and deliveries
/// work there, and how it's doing. What it sells is the Menu tab's.
export function MerchantStore() {
  const routerState = useLocation().state as { editDetails?: string } | null;
  // `editDetails` names the store just published (NewStore.tsx) -- only that
  // store opens straight into its details editor.
  return <ForActiveStore>{(storeHex) => <StoreSettings storeHex={storeHex} openDetailsOnArrival={routerState?.editDetails === storeHex} />}</ForActiveStore>;
}

function StoreSettings({ storeHex, openDetailsOnArrival }: { storeHex: string; openDetailsOnArrival: boolean }) {
  const t = useT();
  const loadStores = useMerchantStores((s) => s.load);
  const { catalogRef, data, reload } = useStore(storeHex);
  const { data: rating } = useResource(`store-rating:${storeHex}`, () => getRatingSummary({ Store: catalogRef }));
  const toggling = useAction();

  // The name, open state and details also show in the store switcher.
  async function reloadProfile() {
    await Promise.all([reload(), loadStores()]);
  }
  // A setting saved: the store as it is now, and a word that it took.
  async function saved() {
    await reload();
    toast(t("common.saved"));
  }
  async function savedProfile() {
    await reloadProfile();
    toast(t("common.saved"));
  }

  if (!data) return <StoreSkeleton />;
  const { catalog, items } = data;
  const avgRating = rating ? averageRating(rating) : null;
  const card = { catalog, catalogRef, onSaved: saved };

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="pb-8">
      <div className="px-4 pt-4">
        <StoreSwitcher />
      </div>
      {catalog.banner_data_uri && <img src={catalog.banner_data_uri} alt="" className="h-32 w-full object-cover" />}
      {/* Its own initial/animate, not inherited variants: inheriting across
          the plain banner element above left every child stuck hidden. */}
      <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4">
        <motion.div variants={fadeSlideUp} className="mb-1 flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{catalog.business_name}</h1>
          {/* Taking orders right now, or not -- the store's own switch. */}
          <div className="flex shrink-0 items-center gap-2.5 rounded-full bg-white py-1.5 pl-3.5 pr-1.5 shadow-[var(--shadow-card)] ring-1 ring-ink-100 dark:bg-ink-900 dark:ring-ink-800">
            <span className={catalog.is_open ? "h-2 w-2 rounded-full bg-presence-500" : "h-2 w-2 rounded-full bg-ink-300 dark:bg-ink-600"} aria-hidden />
            <span className="text-xs font-semibold text-ink-700 dark:text-ink-200">{catalog.is_open ? t("catalog.takingOrders") : t("catalog.notTakingOrders")}</span>
            <Switch
              checked={catalog.is_open}
              disabled={toggling.busy}
              label={t("catalog.takingOrders")}
              onChange={(open) => toggling.run(async () => {
                await setCatalogOpen(catalogRef, open);
                await reloadProfile();
              })}
            />
          </div>
        </motion.div>
        {toggling.error && <Notice className="mb-2">{toggling.error}</Notice>}
        {avgRating !== null && rating && <StarRating value={avgRating} count={rating.count} />}

        <Group icon={StoreIcon} title={t("storePage.storefront")}>
          <StoreDetailsCard catalog={catalog} catalogRef={catalogRef} startEditing={openDetailsOnArrival} onSaved={savedProfile} />
          <HoursCard {...card} />
          <ListingCard catalogRef={catalogRef} />
        </Group>

        <Group icon={Landmark} title={t("storePage.money")}>
          <GettingPaidCard className="mb-4" />
          <TaxCard key={JSON.stringify(catalog.tax_rates ?? [])} {...card} />
          {(catalog.tax_rates ?? []).length > 0 && <TaxReportCard catalogRef={catalogRef} />}
        </Group>

        <Group icon={Clock} title={t("storePage.orders")} columns>
          <AllergyPolicyCard key={JSON.stringify(catalog.allergy_policy ?? null)} {...card} />
          <AutoAcceptCard {...card} />
          <BusyCard key={catalog.busy_extra_minutes} {...card} />
          <MinimumOrderCard {...card} />
          <StoreWaitCard {...card} />
        </Group>

        <Group icon={Truck} title={t("storePage.delivery")} columns>
          <DeliverySubsidyCard {...card} />
          <TipLimitCard {...card} />
          <LeaveAtDoorCard {...card} />
        </Group>

        <Group icon={BarChart3} title={t("storePage.doing")}>
          <InsightsCard catalogRef={catalogRef} items={items} />
          <StoreReviews storeHex={storeHex} catalogRef={catalogRef} />
        </Group>
      </motion.div>
    </motion.div>
  );
}

/// A group of the store's settings, under its heading -- its one-line
/// cards side by side on a wide screen (`columns`).
function Group({ icon, title, columns, children }: { icon: LucideIcon; title: string; columns?: boolean; children: ReactNode }) {
  return (
    <motion.section variants={fadeSlideUp} className="mt-6">
      <GroupHeading icon={icon} title={title} />
      <div className={clsx(columns && "lg:grid lg:grid-cols-2 lg:gap-x-4")}>{children}</div>
    </motion.section>
  );
}
