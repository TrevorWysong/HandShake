// What an order costs, and what it takes to place it -- worked out the way
// the network checks it, from what the customer chose. Pure: no store, no
// clock, so every number checkout shows (and sends) is pinned by
// test/cartPricing.test.ts. The network refuses an order whose totals
// don't hold regardless; this is what lets the customer see them first.
import { orderTax, totalWithTax } from "../../../lib/storefront/tax";
import { toMinorUnits } from "../../../lib/ui/format";
import type { TaxRate } from "../../../holochain/types";

/// The tip: a share of the food (before any discount), or an amount typed.
export function tipCents(subtotalCents: number, percent: number | null, custom: string): number {
  return percent !== null ? Math.round((subtotalCents * percent) / 100) : toMinorUnits(Number(custom || 0));
}

/// The most the customer will pay a driver: a preset, or an amount typed.
export function feeCapCents(preset: number | null, custom: string): number {
  return preset !== null ? preset : toMinorUnits(Number(custom || 0));
}

/// When a scheduled delivery is for, in Holochain's microseconds -- `null`
/// for now. A `datetime-local` value has no zone: `Date.parse` reads it as
/// the device's local time, which is what the customer picked.
export function scheduledTime(scheduled: boolean, scheduledFor: string): number | null {
  return scheduled && scheduledFor ? Date.parse(scheduledFor) * 1000 : null;
}

export interface PriceInput {
  fulfillment: "Delivery" | "Pickup";
  /// The food at menu prices.
  subtotalCents: number;
  /// What a promo or reward takes off it.
  discountCents: number;
  /// Each line's tax category and total, for the store's tax.
  lines: { taxCategory: string; totalCents: number }[];
  taxRates: TaxRate[];
  taxIncluded: boolean;
  tipCents: number;
  maxFeeCents: number;
  /// The share of a delivery fee the store covers, 0-100.
  subsidyPercent: number;
  minOrderCents: number | null;
  /// The menu items' part of the food -- what the minimum is measured
  /// against; goodie bags are already discounted.
  menuSubtotalCents: number;
  leaveAtDoorMaxCents: number | null;
}

export interface Price {
  /// The food after the discount.
  discountedSubtotalCents: number;
  taxCents: number;
  /// What the store is paid: the food and its tax.
  orderTotalCents: number;
  /// The customer's share of a delivery fee at its cap -- the store's
  /// share floor-rounded, as `dispatch_types::split_delivery_fee` splits it.
  customerFeeShareCents: number;
  /// A delivery's worst case: the order, its tip, and the fee at its cap.
  estimatedTotalCents: number;
  /// What the store holds on the customer's card for it -- exactly what
  /// the network requires (`PaymentLeg::required`): a pickup's food, or a
  /// delivery's worst case. What's charged is settled after.
  holdCents: number;
  /// How far the food falls short of the store's minimum (menu prices,
  /// before any promo).
  shortOfMinimumCents: number;
  /// Whether the store lets an order this size be left at the door.
  doorAllowed: boolean;
}

export function priceCheckout(input: PriceInput): Price {
  const discountedSubtotalCents = input.subtotalCents - input.discountCents;
  const taxCents = orderTax(
    input.lines.map((line) => ({ category: line.taxCategory, total: line.totalCents })),
    discountedSubtotalCents,
    input.taxRates,
    input.taxIncluded,
  );
  const orderTotalCents = totalWithTax(discountedSubtotalCents, taxCents, input.taxIncluded);
  const customerFeeShareCents = input.maxFeeCents - Math.floor((input.maxFeeCents * input.subsidyPercent) / 100);
  const estimatedTotalCents = orderTotalCents + input.tipCents + customerFeeShareCents;
  const holdCents = input.fulfillment === "Pickup" ? orderTotalCents : estimatedTotalCents;
  return {
    discountedSubtotalCents,
    taxCents,
    orderTotalCents,
    customerFeeShareCents,
    estimatedTotalCents,
    holdCents,
    // Goodie bags alone aren't held to it.
    shortOfMinimumCents: input.minOrderCents != null && input.menuSubtotalCents > 0 ? Math.max(0, input.minOrderCents - input.menuSubtotalCents) : 0,
    doorAllowed: input.leaveAtDoorMaxCents == null || orderTotalCents <= input.leaveAtDoorMaxCents,
  };
}
