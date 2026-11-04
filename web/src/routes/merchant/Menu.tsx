import { motion } from "framer-motion";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { StoreSwitcher } from "../../components/store/StoreSwitcher";
import { MenuSection } from "./catalog/MenuSection";
import { ChoicesSection } from "./catalog/ChoicesSection";
import { GoodieBagsSection } from "./catalog/GoodieBagsSection";
import { ForActiveStore, StoreSkeleton } from "./ActiveStore";
import { useStore } from "./useStore";
import { useT } from "../../i18n";

/// The Menu tab: what the active store sells -- its items, the choices
/// they offer, and its goodie bags. How the store runs is the Store tab's.
export function MerchantMenu() {
  return <ForActiveStore>{(storeHex) => <StoreMenu storeHex={storeHex} />}</ForActiveStore>;
}

function StoreMenu({ storeHex }: { storeHex: string }) {
  const t = useT();
  const { catalogRef, data, reload } = useStore(storeHex);
  if (!data) return <StoreSkeleton />;
  const { catalog, items, groups } = data;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-8 pt-4">
      <StoreSwitcher />
      <motion.div variants={fadeSlideUp} className="mb-4">
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{t("nav.menu")}</h1>
        <p className="text-sm text-ink-500">{t("menuPage.subtitle", { count: items.length })}</p>
      </motion.div>
      <MenuSection catalogRef={catalogRef} items={items} groups={groups} taxRates={catalog.tax_rates ?? []} onChanged={reload} />
      <ChoicesSection catalogRef={catalogRef} groups={groups} onChanged={reload} />
      <GoodieBagsSection storeHex={storeHex} catalogRef={catalogRef} />
    </motion.div>
  );
}
