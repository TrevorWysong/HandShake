import { useNavigate } from "react-router-dom";
import { Minus, Plus, ShoppingBag, Trash2 } from "lucide-react";
import { cartKey, lineKey, useCart } from "../../store/cart";
import { formatCents } from "../../lib/ui/format";
import { Button, StatNumber } from "../ui";
import { useT } from "../../i18n";

/// The cart beside a store's menu on a wide screen, kept in view while
/// ordering: this store's cart -- its lines, their quantities and the way
/// to checkout. Other stores' carts are their own.
export function StoreCartPanel({ catalogRef }: { catalogRef: Uint8Array }) {
  const t = useT();
  const navigate = useNavigate();
  const key = cartKey(catalogRef);
  const cart = useCart(key);
  const count = cart.count;
  return (
    <aside className="sticky top-6 flex max-h-[calc(100svh-3rem)] flex-col rounded-3xl border border-ink-100 bg-white p-5 dark:border-ink-800 dark:bg-ink-900">
      <p className="flex items-center gap-2 font-bold text-ink-900 dark:text-white">
        <ShoppingBag size={18} className="text-handshake-500" />
        {t("store.yourCart")}
      </p>
      {count === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-400">{t("store.cartEmptyHint")}</p>
      ) : (
        <>
          <ul className="mt-4 -mr-2 flex flex-col gap-3 overflow-y-auto pr-2">
            {cart.lines.map((line) => {
              const key = lineKey(line);
              return (
                <li key={key} className="flex items-start gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{line.name}</span>
                    {line.choiceLabels.length > 0 && <span className="block truncate text-xs text-ink-400">{line.choiceLabels.join(", ")}</span>}
                    <StatNumber className="text-xs text-ink-500">{formatCents(line.priceCents * line.quantity)}</StatNumber>
                  </span>
                  {line.rewardId == null && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-ink-100 p-0.5 dark:bg-ink-800">
                      <button type="button" onClick={() => cart.setQuantity(key, line.quantity - 1)} aria-label={t("item.fewer")} className="grid h-6 w-6 place-items-center rounded-full text-ink-500 hover:bg-white dark:hover:bg-ink-700">
                        {line.quantity === 1 ? <Trash2 size={13} /> : <Minus size={13} />}
                      </button>
                      <span className="w-4 text-center text-xs font-bold">{line.quantity}</span>
                      <button type="button" onClick={() => cart.setQuantity(key, line.quantity + 1)} aria-label={t("item.more")} className="grid h-6 w-6 place-items-center rounded-full text-ink-500 hover:bg-white dark:hover:bg-ink-700">
                        <Plus size={13} />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex items-center justify-between border-t border-ink-100 pt-4 text-sm dark:border-ink-800">
            <span className="text-ink-500">{t("cart.subtotal")}</span>
            <StatNumber className="font-bold">{formatCents(cart.total())}</StatNumber>
          </div>
        </>
      )}
      {count > 0 && (
        <Button className="mt-4 w-full" onClick={() => navigate(`/customer/cart/${key}`)}>
          {t("store.checkout")}
        </Button>
      )}
    </aside>
  );
}
