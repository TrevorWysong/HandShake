// Every store's cart, the way the big apps keep them: one a store, each to
// check out on its own. With one, the Cart tab goes straight to it; with
// several, each shows its store, what's in it and anything in the way of
// ordering it now -- its store closed, or something on it gone -- before
// it's opened.
import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ShoppingBag, X } from "lucide-react";
import { getCatalog } from "../../../holochain/zomes/catalog";
import { decodeEntry } from "../../../holochain/decode";
import type { MerchantCatalog } from "../../../holochain/types";
import { cartKey, cartView, useCarts, type StoreCart } from "../../../store/cart";
import { fetchMenu } from "../../../lib/storefront/menu";
import { storeStatus } from "../../../lib/storefront/storeHours";
import { useResource } from "../../../lib/hooks/useResource";
import { useClock } from "../../../lib/hooks/useClock";
import { formatCents } from "../../../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../../../lib/ui/motion";
import { Button, Card, EmptyState } from "../../../components/ui";
import { useT } from "../../../i18n";

export function Carts() {
  const t = useT();
  const carts = useCarts((s) => s.carts);
  const ordered = Object.values(carts).sort((a, b) => b.touchedAt - a.touchedAt);
  if (ordered.length === 1) return <Navigate to={`/customer/cart/${cartKey(ordered[0].catalogRef)}`} replace />;
  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.h1 variants={fadeSlideUp} className="mb-4 text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        {t("carts.title")}
      </motion.h1>
      {ordered.length === 0 ? (
        <motion.div variants={fadeSlideUp}>
          <EmptyState icon={<ShoppingBag size={32} />} title={t("carts.empty")} subtitle={t("carts.emptyDetail")} />
          <div className="mt-2 flex justify-center">
            <Link to="/customer" className="text-sm font-semibold text-handshake-600 dark:text-handshake-400">
              {t("cart.browse")}
            </Link>
          </div>
        </motion.div>
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {ordered.map((cart) => (
              <motion.div key={cartKey(cart.catalogRef)} layout variants={fadeSlideUp} exit={{ opacity: 0, height: 0 }}>
                <CartCard cart={cart} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}

/// One store's cart: its store, what's in it, and what stands in the way of
/// ordering it now.
function CartCard({ cart }: { cart: StoreCart }) {
  const t = useT();
  const key = cartKey(cart.catalogRef);
  const view = cartView(key, cart, null);
  const now = useClock();
  const [removing, setRemoving] = useState(false);
  const { data: store } = useResource(`cart-store:${key}`, async () => decodeEntry<MerchantCatalog>(await getCatalog(cart.catalogRef)));
  const { data: menu } = useResource(`cart-menu:${key}`, () => fetchMenu(cart.catalogRef));
  const status = store ? storeStatus(store, now) : null;
  // Lines whose item is sold out or gone from the menu -- goodie bags and a
  // reward's line are checked at checkout.
  const gone = menu ? cart.lines.filter((line) => !line.bag && line.rewardId == null && !menu.some((row) => row.item.available && cartKey(row.hash) === cartKey(line.itemRef))).length : 0;

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <Link to={`/customer/merchant/${key}`} className="shrink-0" aria-label={t("carts.viewStore", { store: cart.merchantName })}>
          {store?.banner_data_uri ? (
            <img src={store.banner_data_uri} alt="" className="h-14 w-14 rounded-2xl object-cover" />
          ) : (
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-handshake-400 to-handshake-600 text-2xl">🍽️</span>
          )}
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-ink-900 dark:text-ink-50">{cart.merchantName}</p>
          <p className="text-sm text-ink-500 dark:text-ink-400">
            {t("orders.items", { count: view.count })} · <span className="tabular-nums">{formatCents(view.total())}</span>
          </p>
          {(status && !status.open) || gone > 0 ? (
            <p className="mt-1 text-xs font-semibold text-amber-700 dark:text-amber-300">{[status && !status.open ? status.label : null, gone > 0 ? t("carts.unavailable", { count: gone }) : null].filter(Boolean).join(" · ")}</p>
          ) : null}
        </div>
        <button type="button" onClick={() => setRemoving(true)} aria-label={t("carts.remove", { store: cart.merchantName })} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-400 transition hover:bg-ink-100 hover:text-ink-700 dark:hover:bg-ink-800 dark:hover:text-ink-200">
          <X size={16} />
        </button>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {removing ? (
          <motion.div key="remove" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-800/60">
            <p className="text-xs font-semibold text-ink-700 dark:text-ink-200">{t("carts.removeAsk", { store: cart.merchantName })}</p>
            <div className="mt-2 flex gap-2">
              <Button variant="ghost" className="flex-1 py-2 text-xs" onClick={() => setRemoving(false)}>
                {t("cart.replace.keep")}
              </Button>
              <Button variant="danger" className="flex-1 py-2 text-xs" onClick={view.clear}>
                {t("carts.removeButton")}
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="open" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-3 flex gap-2">
            <Link to={`/customer/merchant/${key}`} className="flex flex-1 items-center justify-center rounded-full border border-ink-200 py-2.5 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 dark:border-ink-700 dark:text-ink-200 dark:hover:bg-ink-800">
              {t("carts.addItems")}
            </Link>
            <Link to={`/customer/cart/${key}`} className="flex flex-[2] items-center justify-center rounded-full bg-handshake-500 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-glow)] transition hover:bg-handshake-600">
              {t("carts.view")}
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}
