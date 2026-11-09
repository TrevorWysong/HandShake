// A store's own orders over a period, from its history on its own device --
// what its tax report and its insights are counted from. Nothing about a
// store's trade is compiled anywhere else.
import type { DeliveryOrder, DeliveryStatus, OrderDecisions, PickupOrder, PickupStatus } from "../../holochain/types";
import { decodeEntry } from "../../holochain/decode";
import { getOrderDecisions, getOrderHistoryForStore, type OrderEntry } from "../../holochain/zomes/dispatch";

export type Outcome = "completed" | "cancelled" | "open";

export interface StoreOrder {
  kind: OrderEntry["kind"];
  order: DeliveryOrder | PickupOrder;
  outcome: Outcome;
  /// What the store refunded of it, if it's completed.
  refundedCents: number;
}

/// Where an order ended for the store. A sale is completed once its food is
/// the customer's: a pickup collected, a delivery delivered or collected --
/// or picked up and settled as delivered (`settle_stalled_delivery`), its
/// status left as it was.
export function outcomeOf(kind: OrderEntry["kind"], status: DeliveryStatus | PickupStatus, settledDelivered: boolean): Outcome {
  if (status === "Cancelled") return "cancelled";
  const completed = kind === "Pickup" ? status === "PickedUp" : status === "Delivered" || status === "Collected" || (status === "PickedUp" && settledDelivered);
  return completed ? "completed" : "open";
}

/// Whether an order's decisions are needed to count it: a completed sale's
/// refund, and whether a delivery picked up was settled as delivered.
const needsDecisions = (kind: OrderEntry["kind"], status: string) => (kind === "Pickup" ? status === "PickedUp" : status === "Delivered" || status === "Collected" || status === "PickedUp");

/// History pages read at most, so a long history can't stall a report.
const PAGE = 50;
/// Orders' decisions read at once.
const AT_ONCE = 8;

/// The store's orders placed in [from, to), newest first, read a page of
/// history at a time to at most `maxPages` -- each page's decisions read
/// together, a few at a time.
export async function storeOrdersBetween(catalogRef: Uint8Array, from: Date, to: Date | null, maxPages: number): Promise<StoreOrder[]> {
  const fromMicros = from.getTime() * 1000;
  const toMicros = to ? to.getTime() * 1000 : Infinity;
  const orders: StoreOrder[] = [];
  let before: number | null = to ? toMicros - 1 : null;
  for (let page = 0; page < maxPages; page++) {
    const result = await getOrderHistoryForStore(catalogRef, before, PAGE);
    const placed = result.orders.map((entry) => ({ entry, order: decodeEntry<DeliveryOrder | PickupOrder>(entry.record) }));
    const inRange = placed.filter(({ order }) => order.requested_at >= fromMicros && order.requested_at < toMicros);
    // A refund that can't be read fails the read: counting it as none would
    // overstate what the store sold, and the tax on it.
    const decisions = await eachAtMost(inRange, AT_ONCE, ({ entry, order }) => (needsDecisions(entry.kind, order.status) ? getOrderDecisions(entry.original_action) : Promise.resolve(null)));
    inRange.forEach(({ entry, order }, i) => {
      const decided: OrderDecisions | null = decisions[i];
      const outcome = outcomeOf(entry.kind, order.status, !!decided?.delivered);
      orders.push({ kind: entry.kind, order, outcome, refundedCents: outcome === "completed" ? (decided?.refund ?? 0) : 0 });
    });
    if (placed.some(({ order }) => order.requested_at < fromMicros) || result.next_before === null) break;
    before = result.next_before;
  }
  return orders;
}

/// `work` on each of `items`, at most `limit` at a time, in order.
async function eachAtMost<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
