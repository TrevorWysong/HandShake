import { NavLink } from "react-router-dom";
import { motion } from "framer-motion";
import clsx from "clsx";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { StoreSwitcher } from "../../components/store/StoreSwitcher";
import { PromoCodesCard } from "./catalog/PromoCodesCard";
import { ForActiveStore, StoreSkeleton } from "./ActiveStore";
import { useStore } from "./useStore";
import { useT } from "../../i18n";
import { PROMO_PAGES } from "./promoPages";

/// The switch between the Promos tab's pages (`PROMO_PAGES`).
export function PromosTabs() {
  const t = useT();
  const labels = { "/merchant/promos": t("promosPage.codes"), "/merchant/rewards": t("promosPage.rewards") };
  return (
    <nav className="mb-4 flex rounded-full bg-ink-100 p-1 text-sm font-semibold dark:bg-ink-800" aria-label={t("nav.promos")}>
      {PROMO_PAGES.map((to) => (
        <NavLink
          key={to}
          to={to}
          end
          className={({ isActive }) =>
            clsx("flex-1 rounded-full px-3 py-1.5 text-center transition", isActive ? "bg-white text-ink-900 shadow-sm dark:bg-ink-950 dark:text-white" : "text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-200")
          }
        >
          {labels[to]}
        </NavLink>
      ))}
    </nav>
  );
}

/// The store's promo codes.
export function MerchantPromos() {
  return <ForActiveStore>{(storeHex) => <StorePromos storeHex={storeHex} />}</ForActiveStore>;
}

function StorePromos({ storeHex }: { storeHex: string }) {
  const t = useT();
  const { catalogRef, data } = useStore(storeHex);
  if (!data) return <StoreSkeleton />;
  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-8 pt-4">
      <StoreSwitcher />
      <PromosTabs />
      <motion.p variants={fadeSlideUp} className="mb-3 px-1 text-sm text-ink-500">{t("promosPage.codesSubtitle")}</motion.p>
      <motion.div variants={fadeSlideUp}>
        <PromoCodesCard storeHex={storeHex} catalogRef={catalogRef} items={data.items} />
      </motion.div>
    </motion.div>
  );
}
