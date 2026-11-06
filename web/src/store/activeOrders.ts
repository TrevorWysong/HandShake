// The signed-in customer's orders in progress, read once for the whole app --
// the Orders tab, and the card that follows them everywhere (`AppShell` polls).
// With each, what the card needs beyond the order itself: its store's name, when
// it's due, and whether it's waiting on them.
import { create } from "zustand";
import { actionHash, decodeEntry, bytesToHex } from "../holochain/decode";
import { getCatalog } from "../holochain/zomes/catalog";
import { getMyActiveOrders, getOrder, getPickupOrder, listBidsForOrder } from "../holochain/zomes/dispatch";
import { myPayment } from "../holochain/zomes/payments";
import type { Bid, DeliveryOrder, MerchantCatalog, PickupOrder } from "../holochain/types";
import { isFinished, toOrderRow, type OrderRow } from "../lib/orders/orderEntries";
import type { OrderNeed } from "../lib/orders/progress";

export interface ActiveOrder {
  row: OrderRow;
  storeName: string | null;
  need: OrderNeed | null;
  /// When its driver said they'd arrive, in microseconds.
  driverDueAt: number | null;
}

/// How long an order that just finished stays on the card: the moment it's
/// delivered, or called off, is the one its customer wants to see.
export const FINISHED_SHOWN_MICROS = 10 * 60 * 1_000_000;

export interface FinishedOrder extends ActiveOrder {
  /// When this app saw it finish, in microseconds.
  finishedAt: number;
}

interface ActiveOrdersState {
  /// Whose these are: a read that lands after an identity's changed is ignored.
  owner: string | null;
  orders: ActiveOrder[] | undefined;
  finished: FinishedOrder[];
  refresh: (owner: string) => Promise<void>;
  dismissFinished: (hex: string) => void;
}

// What doesn't change, read once: a store's name is near enough, a driver's
// bid is fixed. Keyed, and bounded by how many orders one person has going.
const storeNames = new Map<string, string>();
const driverDue = new Map<string, number | null>();

async function storeNameOf(row: OrderRow): Promise<string | null> {
  const hex = bytesToHex(row.order.catalog_ref);
  const known = storeNames.get(hex);
  if (known) return known;
  const name = await getCatalog(row.order.catalog_ref).then((record) => decodeEntry<MerchantCatalog>(record).business_name, () => null);
  if (name) storeNames.set(hex, name);
  return name;
}

async function driverDueOf(row: OrderRow): Promise<number | null> {
  if (row.kind !== "Delivery" || !row.order.accepted_bid) return null;
  const hex = bytesToHex(row.order.accepted_bid);
  const known = driverDue.get(hex);
  if (known !== undefined) return known;
  const bids = await listBidsForOrder(row.ref).catch(() => null);
  if (!bids) return null;
  const won = bids.bids.find((record) => bytesToHex(actionHash(record)) === hex);
  const bid = won ? decodeEntry<Bid>(won) : null;
  const due = bid ? bid.created_at + bid.eta_seconds * 1_000_000 : null;
  driverDue.set(hex, due);
  return due;
}

/// Whether the order's stuck on its customer: a card to deal with while the
/// store's waiting on it, or drivers to choose from. Best effort -- a read that
/// fails says nothing, and the order's own page still shows it.
async function needOf(row: OrderRow): Promise<OrderNeed | null> {
  if (row.order.status === "Placed") {
    const standing = await myPayment(row.ref, "Customer").catch(() => null);
    if (standing && ("ActionNeeded" in standing || "Declined" in standing)) return "pay";
    return null;
  }
  if (row.kind === "Delivery" && row.order.status === "Open" && !row.order.auto_match) {
    const bids = await listBidsForOrder(row.ref).catch(() => null);
    if (bids?.bids.length) return "chooseDriver";
  }
  return null;
}

/// The order's state now, if it's finished -- an order leaves the active queue
/// when it does.
async function finishedRow(previous: OrderRow): Promise<OrderRow | null> {
  const row: OrderRow | null = await (previous.kind === "Delivery"
    ? getOrder(previous.ref).then((record) => ({ ...previous, order: decodeEntry<DeliveryOrder>(record) }))
    : getPickupOrder(previous.ref).then((record) => ({ ...previous, order: decodeEntry<PickupOrder>(record) }))
  ).catch(() => null);
  return row && isFinished(row) ? row : null;
}

export const useActiveOrders = create<ActiveOrdersState>((set, get) => ({
  owner: null,
  orders: undefined,
  finished: [],
  refresh: async (owner) => {
    const rows = (await getMyActiveOrders()).map(toOrderRow);
    const orders = await Promise.all(
      rows.map(async (row): Promise<ActiveOrder> => {
        const [storeName, need, driverDueAt] = await Promise.all([storeNameOf(row), needOf(row), driverDueOf(row)]);
        return { row, storeName, need, driverDueAt };
      }),
    );
    const before = get();
    if (before.owner !== null && before.owner !== owner) return set({ owner, orders, finished: [] });
    const here = new Set(orders.map((o) => o.row.hex));
    const left = (before.orders ?? []).filter((o) => !here.has(o.row.hex));
    const now = Date.now() * 1000;
    const newlyFinished = await Promise.all(
      left.map(async (o): Promise<FinishedOrder | null> => {
        const row = await finishedRow(o.row);
        return row && { ...o, row, need: null, finishedAt: now };
      }),
    );
    const after = get();
    if (after.owner !== null && after.owner !== owner) return;
    const known = new Set(after.finished.map((o) => o.row.hex));
    const finished = [...after.finished, ...newlyFinished.filter((o): o is FinishedOrder => o !== null && !known.has(o.row.hex))];
    set({ owner, orders, finished });
  },
  dismissFinished: (hex) => set((state) => ({ finished: state.finished.filter((o) => o.row.hex !== hex) })),
}));
