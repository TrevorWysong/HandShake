// The same cases as `catalog_types::share`'s tests: keep them in step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextShare, shareAt, shareProblem } from "../src/lib/storefront/deliveryShare.ts";
import { promoAllows } from "../src/lib/storefront/promotions.ts";
import type { PromoLimits } from "../src/holochain/types.ts";

const tier = (from_cents: number, percent: number) => ({ from_cents, percent });

test("a share steps up at each tier an order reaches", () => {
  const share = { base: 50, tiers: [tier(1500, 75), tier(2500, 100)] };
  assert.equal(shareAt(share, 0), 50);
  assert.equal(shareAt(share, 1499), 50);
  assert.equal(shareAt(share, 1500), 75, "from its order size, not above it");
  assert.equal(shareAt(share, 2499), 75);
  assert.equal(shareAt(share, 9999), 100, "free delivery on the largest");
  assert.equal(shareAt({ base: 30, tiers: [] }, 9999), 30, "no tiers: the base on every order");
});

test("the next share, and how much more food reaches it", () => {
  const share = { base: 0, tiers: [tier(1500, 50), tier(2500, 100)] };
  assert.deepEqual(nextShare(share, 1200), { percent: 50, fromCents: 1500, moreCents: 300 });
  assert.deepEqual(nextShare(share, 1500), { percent: 100, fromCents: 2500, moreCents: 1000 });
  assert.equal(nextShare(share, 2500), null, "at the top");
  assert.equal(nextShare({ base: 50, tiers: [] }, 0), null);
});

test("tiers grow in order size and share", () => {
  assert.equal(shareProblem({ base: 50, tiers: [tier(1500, 75), tier(2500, 100)] }), null);
  assert.equal(shareProblem({ base: 0, tiers: [tier(2500, 100)] }), null, "free delivery over $25, nothing below");
  assert.equal(shareProblem({ base: 101, tiers: [] }), "range");
  assert.equal(shareProblem({ base: 50, tiers: [tier(0, 75)] }), "order", "a tier is for a larger order than any");
  assert.equal(shareProblem({ base: 50, tiers: [tier(1500, 50)] }), "order", "a tier covers more than the base");
  assert.equal(shareProblem({ base: 50, tiers: [tier(2500, 75), tier(1500, 100)] }), "order", "smallest first");
  assert.equal(shareProblem({ base: 50, tiers: [tier(1500, 100), tier(2500, 90)] }), "order", "never less for more");
  assert.equal(shareProblem({ base: 50, tiers: [tier(1500, 101)] }), "range");
  assert.equal(shareProblem({ base: 10, tiers: [tier(100, 20), tier(200, 30), tier(300, 40), tier(400, 50), tier(500, 60)] }), "tooMany", "at most four");
});

test("a promo for one way of getting an order is only for that way", () => {
  const limits = (only: PromoLimits["only"]) => ({ first_order_only: false, only, per_customer: null, once_per: null, total: null }) as PromoLimits;
  assert.equal(promoAllows(limits(null), true), true);
  assert.equal(promoAllows(limits(null), false), true);
  assert.equal(promoAllows(limits("Delivery"), true), true);
  assert.equal(promoAllows(limits("Delivery"), false), false);
  assert.equal(promoAllows(limits("Pickup"), false), true);
  assert.equal(promoAllows(limits("Pickup"), true), false);
});
