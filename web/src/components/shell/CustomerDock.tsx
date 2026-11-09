// What floats above a phone's bottom bar for a customer: their order in
// progress and, on a store's page, the way to its cart -- stacked in one place
// so neither sits on the other.
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ShoppingBag } from "lucide-react";
import clsx from "clsx";
import { useCart } from "../../store/cart";
import { formatCents } from "../../lib/ui/format";
import { useT } from "../../i18n";
import type { CardOrder } from "../../lib/hooks/useCardOrders";
import { ActiveOrderCard } from "./ActiveOrderCard";

/// The store whose page this is, if it's one: its `cartKey`.
const storeOfPage = (pathname: string) => /^\/customer\/merchant\/([^/]+)$/.exec(pathname)?.[1] ?? null;

/// The store's cart's button on its page, until the window has room to show
/// the cart beside the menu.
function CartButton({ store }: { store: string }) {
  const t = useT();
  const navigate = useNavigate();
  const cart = useCart(store);
  const count = cart.count;
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.button
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 30 }}
          whileTap={{ scale: 0.97 }}
          onClick={() => navigate(`/customer/cart/${store}`)}
          className="pointer-events-auto flex w-full items-center justify-between rounded-full bg-handshake-500 px-5 py-3.5 font-semibold text-white shadow-[var(--shadow-glow)] transition-colors hover:bg-handshake-600 2xl:hidden"
        >
          <span className="flex items-center gap-2">
            <ShoppingBag size={18} />
            {t("store.viewCart")} · {t("orders.items", { count })}
          </span>
          <span>{formatCents(cart.total())}</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}

export function CustomerDock({ cards, pathname, wide }: { cards: CardOrder[]; pathname: string; wide: boolean }) {
  const store = storeOfPage(pathname);
  return (
    <div className={clsx("pointer-events-none fixed inset-x-0 z-20 mx-auto flex max-w-md flex-col gap-2 px-4 md:max-w-2xl", wide ? "bottom-6 lg:left-sidebar" : "bottom-[calc(4.75rem+env(safe-area-inset-bottom))]")}>
      {!wide && <ActiveOrderCard cards={cards} />}
      {store && <CartButton store={store} />}
    </div>
  );
}
