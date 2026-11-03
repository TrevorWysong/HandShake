import assert from "node:assert/strict";
import { test } from "node:test";
import { feeCapCents, priceCheckout, scheduledTime, tipCents, type PriceInput } from "../src/routes/customer/cart/pricing.ts";

const base: PriceInput = {
  menuSubtotalCents: 2000,
  fulfillment: "Delivery",
  subtotalCents: 2000,
  discountCents: 0,
  lines: [{ taxCategory: "", totalCents: 2000 }],
  taxRates: [],
  taxIncluded: false,
  tipCents: 0,
  maxFeeCents: 500,
  subsidyPercent: 0,
  minOrderCents: null,
  leaveAtDoorMaxCents: null,
};

test("a tip is a share of the food before discounts, or what was typed", () => {
  assert.equal(tipCents(2333, 15, ""), 350);
  assert.equal(tipCents(2000, null, "3.5"), 350);
  assert.equal(tipCents(2000, null, ""), 0);
  assert.equal(feeCapCents(700, "9"), 700);
  assert.equal(feeCapCents(null, "6.25"), 625);
});

test("a scheduled delivery is for the picked local time, in microseconds", () => {
  assert.equal(scheduledTime(false, "2026-11-02T12:00"), null);
  assert.equal(scheduledTime(true, ""), null);
  assert.equal(scheduledTime(true, "2026-11-02T12:00"), Date.parse("2026-11-02T12:00") * 1000);
});

test("tax on top, the fee split as settlement splits it, and the worst case", () => {
  const price = priceCheckout({ ...base, discountCents: 200, taxRates: [{ category: "", label: "Tax", basis_points: 700 }], tipCents: 300, maxFeeCents: 999, subsidyPercent: 50 });
  assert.equal(price.discountedSubtotalCents, 1800);
  assert.equal(price.taxCents, 126);
  assert.equal(price.orderTotalCents, 1926);
  // The store's half floor-rounded: 499, so the customer's 500.
  assert.equal(price.customerFeeShareCents, 500);
  assert.equal(price.estimatedTotalCents, 1926 + 300 + 500);
  assert.equal(price.holdCents, price.estimatedTotalCents);
});

test("tax already in the prices isn't added again", () => {
  const price = priceCheckout({ ...base, taxRates: [{ category: "", label: "VAT", basis_points: 2000 }], taxIncluded: true });
  assert.equal(price.orderTotalCents, 2000);
  assert.ok(price.taxCents > 0);
});

test("a pickup holds the order alone", () => {
  const price = priceCheckout({ ...base, fulfillment: "Pickup", tipCents: 300 });
  assert.equal(price.holdCents, price.orderTotalCents);
});

test("the store's minimum is on menu prices, and the door limit on the order", () => {
  assert.equal(priceCheckout({ ...base, minOrderCents: 2500, discountCents: 1000 }).shortOfMinimumCents, 500);
  assert.equal(priceCheckout({ ...base, minOrderCents: 1500, discountCents: 1000 }).shortOfMinimumCents, 0);
  assert.equal(priceCheckout({ ...base, leaveAtDoorMaxCents: 1999 }).doorAllowed, false);
  assert.equal(priceCheckout({ ...base, leaveAtDoorMaxCents: 2000 }).doorAllowed, true);
});
