// Decoded order-queue entries (see `dispatch_integrity::order_queues`),
// shared by every screen that lists orders -- customer, merchant, driver.
import { decodeEntry, bytesToHex, timestampOf } from "../../holochain/decode";
import type { OrderEntry } from "../../holochain/zomes/dispatch";
import type { DeliveryOrder, OrderLine, PickupOrder, DeliveryStatus } from "../../holochain/types";

/// `ref` is the order's stable identity (its original action) -- what every
/// order call and detail route takes; `hex` is the same, as a React key.
/// `writtenAt` is when its current version was written (microseconds) --
/// for an order waiting on its store, when it reached the store.
type RowBase = { ref: Uint8Array; hex: string; writtenAt: number };
export type OrderRow = (RowBase & { kind: "Delivery"; order: DeliveryOrder }) | (RowBase & { kind: "Pickup"; order: PickupOrder });

export function toOrderRow(entry: OrderEntry): OrderRow {
  const base = { ref: entry.original_action, hex: bytesToHex(entry.original_action), writtenAt: timestampOf(entry.record) };
  return entry.kind === "Delivery"
    ? { ...base, kind: "Delivery", order: decodeEntry<DeliveryOrder>(entry.record) }
    : { ...base, kind: "Pickup", order: decodeEntry<PickupOrder>(entry.record) };
}

/// Appends a history page to what's already shown: no duplicates (a page
/// boundary can repeat an order), newest first.
export function mergeNewestFirst<R extends OrderRow>(existing: R[], incoming: R[]): R[] {
  const seen = new Set(existing.map((row) => row.hex));
  return [...existing, ...incoming.filter((row) => !seen.has(row.hex))].sort((a, b) => b.order.requested_at - a.order.requested_at);
}

/// How many units an order is for, across its lines.
export function itemCount(order: { lines: OrderLine[] }): number {
  return order.lines.reduce((sum, line) => sum + line.quantity, 0);
}

/// Whether a delivery reached its customer: brought to them, or collected
/// from the store when no driver came.
export function received(status: DeliveryStatus): boolean {
  return status === "Delivered" || status === "Collected";
}

/// Finished -- the mirror of the Rust `is_terminal` on both status enums. A
/// delivery that's been picked up is on its way; a pickup that has is done.
export function isFinished(row: OrderRow): boolean {
  return row.kind === "Delivery" ? received(row.order.status) || row.order.status === "Cancelled" : row.order.status === "PickedUp" || row.order.status === "Cancelled";
}

/// Whether the store's done with an order: finished, or gone with its driver.
export function leftTheStore(row: OrderRow): boolean {
  return isFinished(row) || row.order.status === "PickedUp";
}

/// The customer-facing detail route for an order.
export function customerOrderPath(row: OrderRow): string {
  return row.kind === "Delivery" ? `/customer/orders/${row.hex}` : `/customer/pickup-orders/${row.hex}`;
}
