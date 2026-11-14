// Ordering a past order again: the cart rebuilt from it against the store's
// *current* menu -- an item since removed is dropped and a repriced one takes
// its new price, rather than failing the whole reorder over one stale line --
// and the customer taken to it. A cart already started at that store is only
// replaced once they say so.
import { useNavigate } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import clsx from "clsx";
import type { MerchantCatalog, OrderLine } from "../../holochain/types";
import { getCatalog } from "../../holochain/zomes/catalog";
import { decodeEntry } from "../../holochain/decode";
import { cartKey, useCarts } from "../../store/cart";
import { NoLongerSignedIn, stillSignedIn } from "../../store/identityScope";
import { useCartReplace } from "../../lib/hooks/useCartReplace";
import { cartLinesFromOrder, fetchMenu } from "../../lib/storefront/menu";
import { useAction } from "../../lib/hooks/useAction";
import { useT } from "../../i18n";
import { Button } from "../ui";
import { ReplaceCartSheet } from "../store/ReplaceCartSheet";

/// What a reorder needs of an order, delivery or pickup.
export interface Reorderable {
  catalog_ref: Uint8Array;
  merchant: Uint8Array;
  lines: OrderLine[];
}

/// `compact`: a small pill beside an order in a list; otherwise a full-width
/// button for an order's own page. Either says why, beneath it, if the order
/// couldn't be rebuilt.
export function ReorderButton({ order, compact = false }: { order: Reorderable; compact?: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const reordering = useAction();
  const replacing = useCartReplace();

  const reorder = () =>
    reordering.run(async () => {
      const current = stillSignedIn();
      const [catalogRecord, menuItems] = await Promise.all([getCatalog(order.catalog_ref), fetchMenu(order.catalog_ref)]);
      const catalog = decodeEntry<MerchantCatalog>(catalogRecord);
      const lines = await cartLinesFromOrder(order.catalog_ref, order.lines, menuItems);
      if (!current()) throw new NoLongerSignedIn();
      useCarts.getState().setCart(order.catalog_ref, order.merchant, catalog.business_name, lines);
      navigate(`/customer/cart/${cartKey(order.catalog_ref)}`);
    });

  return (
    <div className={clsx("flex flex-col", compact ? "shrink-0 items-end" : "w-full")}>
      <Button variant={compact ? "ghost" : "secondary"} className={compact ? "px-3 py-1.5 text-xs" : "w-full"} loading={reordering.busy} onClick={() => replacing.ask(order.catalog_ref, reorder)}>
        {!reordering.busy && <RotateCcw size={compact ? 13 : 16} aria-hidden />}
        {t("orders.reorder")}
      </Button>
      {reordering.error && (
        <p role="alert" className={clsx("mt-1 text-xs text-red-600 dark:text-red-400", compact && "max-w-[10rem] text-right")}>
          {reordering.error}
        </p>
      )}
      <ReplaceCartSheet pending={replacing.pending} onConfirm={replacing.confirm} onCancel={replacing.cancel} />
    </div>
  );
}
