// A store's tax report: what it sold in a period and the tax it collected,
// net of the tax it refunded on reports of missing items -- computed on the
// store's own device from its own order history, so its sales are never
// compiled anywhere else (docs/TAX_REPORTING.md). What it files is its own.
import { storeOrdersBetween } from "./storeOrders";

/// One completed order, as the report lists it.
export interface TaxedOrder {
  placedAt: Date;
  /// What the customer paid the store (with tax when it's added on top).
  totalCents: number;
  taxCents: number;
  /// What the store refunded on reports, and the tax in it.
  refundedCents: number;
  refundedTaxCents: number;
}

export interface TaxReport {
  orders: TaxedOrder[];
  salesCents: number;
  taxCents: number;
  refundedTaxCents: number;
  /// The tax collected, less what was refunded.
  netTaxCents: number;
}

/// History pages read at most, so a long history can't stall the report.
const MAX_PAGES = 200;

/// A refund's share of the tax: the same share of the order it is.
export function refundedTax(refundCents: number, totalCents: number, taxCents: number): number {
  return totalCents === 0 ? 0 : Math.round((refundCents * taxCents) / totalCents);
}

export function summarize(orders: TaxedOrder[]): TaxReport {
  const sum = (pick: (o: TaxedOrder) => number) => orders.reduce((total, o) => total + pick(o), 0);
  const taxCents = sum((o) => o.taxCents);
  const refundedTaxCents = sum((o) => o.refundedTaxCents);
  return { orders, salesCents: sum((o) => o.totalCents - o.refundedCents), taxCents, refundedTaxCents, netTaxCents: taxCents - refundedTaxCents };
}

/// The store's completed orders placed in [from, to), and their tax.
export async function storeTaxReport(catalogRef: Uint8Array, from: Date, to: Date): Promise<TaxReport> {
  const orders: TaxedOrder[] = (await storeOrdersBetween(catalogRef, from, to, MAX_PAGES))
    .filter(({ outcome }) => outcome === "completed")
    .map(({ order, refundedCents }) => {
      const taxCents = order.tax_cents ?? 0;
      return { placedAt: new Date(order.requested_at / 1000), totalCents: order.order_total, taxCents, refundedCents, refundedTaxCents: refundedTax(refundedCents, order.order_total, taxCents) };
    });
  return summarize(orders.sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime()));
}

/// The report's orders as CSV, for the store's accountant.
export function taxReportCsv(report: TaxReport, minor: (cents: number) => string): string {
  const rows = report.orders.map((o) => [o.placedAt.toISOString(), minor(o.totalCents), minor(o.taxCents), minor(o.refundedCents), minor(o.refundedTaxCents)].join(","));
  return ["placed_at,total,tax,refunded,refunded_tax", ...rows].join("\n");
}
