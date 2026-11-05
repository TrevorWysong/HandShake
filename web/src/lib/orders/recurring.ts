// A customer's recurring orders, and taking one to checkout. An order is only
// ever placed by them, there: `dispatch::recurring` reminds them at its time,
// and they pay then, with a card they have with them.
import { advanceRecurringTemplate, listMyRecurringTemplates } from "../../holochain/zomes/dispatch";
import { getCatalog } from "../../holochain/zomes/catalog";
import { bytesToHex, decodeEntry } from "../../holochain/decode";
import type { DropoffPreference, GeoPoint, MerchantCatalog, RecurringDue, RecurringOrderTemplate, TemplateDetails } from "../../holochain/types";
import { t } from "../../i18n";
import { useCart } from "../../store/cart";
import { cartLinesFromItems, fetchMenu } from "../storefront/menu";

export interface RecurringOrder {
  hash: Uint8Array;
  hex: string;
  template: RecurringOrderTemplate;
  details: TemplateDetails | null;
  storeName: string;
  due: RecurringDue;
}

export async function fetchRecurringOrders(): Promise<RecurringOrder[]> {
  return Promise.all(
    (await listMyRecurringTemplates()).map(async (view) => {
      const template = decodeEntry<RecurringOrderTemplate>(view.record);
      const storeName = await getCatalog(template.catalog_ref)
        .then((record) => decodeEntry<MerchantCatalog>(record).business_name)
        .catch(() => t("orders.restaurant"));
      return { hash: view.original_action, hex: bytesToHex(view.original_action), template, details: view.details, storeName, due: view.due };
    }),
  );
}

/// How checkout starts for a recurring order: as it was set up, for its
/// customer to look over. Leaving it at the door is asked about again there.
export interface CheckoutDraft {
  dropoff: GeoPoint | null;
  dropoffLine2: string;
  dropoffNotes: string;
  kitchenNotes: string;
  tipCents: number;
  feeCapCents: number | null;
  preference: DropoffPreference;
  priority: boolean;
}

/// Puts `order` in the bag at the store's current menu and moves it on to
/// its next time. Returns how checkout starts; nothing's ordered or charged.
export async function takeToCheckout(order: RecurringOrder): Promise<CheckoutDraft> {
  const { template, details } = order;
  const lines = await cartLinesFromItems(template.catalog_ref, template.items, await fetchMenu(template.catalog_ref));
  if (lines.length === 0) throw new Error(t("recurring.nothingLeft", { store: order.storeName }));
  await advanceRecurringTemplate(order.hash);
  const cart = useCart.getState();
  cart.setCart(template.catalog_ref, template.merchant, order.storeName, lines);
  cart.choosePromo(template.promo_code_ref ? bytesToHex(template.promo_code_ref) : null);
  return {
    dropoff: details?.dropoff ?? null,
    dropoffLine2: details?.dropoff_line2 ?? "",
    dropoffNotes: details?.dropoff_notes ?? "",
    kitchenNotes: details?.kitchen_notes ?? "",
    tipCents: template.tip_cents,
    feeCapCents: template.max_delivery_fee,
    preference: template.dropoff_preference,
    priority: details?.priority ?? false,
  };
}
