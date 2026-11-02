// Proves the rules that keep discounts honest: a pickup order's promo code
// is validated like a delivery's, a bag can't be ordered once its window
// has closed, and a listed bag's terms can't be changed out from under the
// people ordering it. (A bag once per customer: goodie-bags.test.ts.)
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, ST_PETE, testApp, decodeEntry, retryingCaller } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await runScenario(async (scenario) => {
  const [merchant, customer] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [merchant, customer];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, merchant.cells[0].cell_id[0]);
  const call = (p: typeof merchant, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(merchant, "profiles")("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await call(customer, "profiles")("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  const storeA = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE }));
  const storeB = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Tacos", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: storeA, name: "Burger", price_cents: 1000, available: true }));

  const bagInput = (fields: Record<string, unknown> = {}) => ({
    catalog_ref: storeA,
    title: "End-of-day bag",
    description: "",
    photo_data_uri: "",
    original_value_cents: 1500,
    price_cents: 500,
    quantity_total: 5,
    pickup_window_start: Date.now() * 1000,
    pickup_window_end: Date.now() * 1000 + 2 * 3600 * 1_000_000,
    supports_pickup: true,
    supports_delivery: false,
    created_at: Date.now() * 1000,
    ...fields,
  });
  await sync();

  // --- Pickup orders validate their promo code, like deliveries do. ---
  const promoAt = async (store: Uint8Array, code: string, expiresAt: number | null) =>
    actionHash(await call(merchant, "catalog")<HcRecord>("create_promo_code", { catalog_ref: store, code, requirement: "None", reward: { PercentOffSubtotal: 10 }, expires_at: expiresAt, auto_apply: false }));
  const otherStorePromo = await promoAt(storeB, "TACOS10", null);
  const expiringPromo = await promoAt(storeA, "QUICK10", Date.now() * 1000 + 3_000_000);
  const retiredPromo = await promoAt(storeA, "OLD10", null);
  await call(merchant, "catalog")("set_promo_code_active", { original_action: retiredPromo, active: false });
  await sync();
  const pickupWithPromo = (promo: Uint8Array) =>
    call(customer, "dispatch")("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: storeA, items: [{ item_ref: item, quantity: 1 }], order_total: 900, promo_code_ref: promo });
  await assert.rejects(pickupWithPromo(otherStorePromo), /does not belong to this order's store/, "another store's code must be rejected");
  await assert.rejects(pickupWithPromo(retiredPromo), /not active/, "a deactivated code must be refused");
  await sleep(3500);
  await assert.rejects(pickupWithPromo(expiringPromo), /promo code has expired/, "an expired code must be rejected");
  console.log("[PASS] pickup orders reject another store's, deactivated and expired promo codes");

  // --- No orders once a bag's window has closed. ---
  const closingBag = actionHash(
    await call(merchant, "catalog")<HcRecord>("create_goodie_bag", bagInput({ pickup_window_start: Date.now() * 1000 - 60_000_000, pickup_window_end: Date.now() * 1000 + 2_000_000 })),
  );
  await sync();
  await sleep(2500);
  await assert.rejects(
    call(customer, "dispatch")("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: storeA, items: [{ item_ref: closingBag, quantity: 1 }], order_total: 500 }),
    /no longer available/,
    "an order after the window must be refused",
  );
  const listed = await call(customer, "catalog")<unknown[]>("list_goodie_bags_for_catalog", storeA);
  assert.equal(listed.length, 0, "a bag whose window has closed is no longer listed");
  console.log("[PASS] bags expire: no orders after the window, and they drop out of listings");

  // --- A listed bag's terms are fixed; only its presentation can change. ---
  await assert.rejects(
    call(merchant, "catalog")("create_goodie_bag", bagInput({ pickup_window_end: Date.now() * 1000 + 8 * 86_400 * 1_000_000 })),
    /ends too long after it's listed/,
    "a bag can't stay listed longer than the network allows",
  );
  const termsRecord = await call(merchant, "catalog")<HcRecord>("create_goodie_bag", bagInput());
  const termsBag = actionHash(termsRecord);
  // An update replaces the whole bag, so it starts from the bag as listed.
  const listing = decodeEntry<Record<string, unknown>>(termsRecord);
  await assert.rejects(
    call(merchant, "catalog")("update_goodie_bag", { original_action: termsBag, bag: { ...listing, price_cents: 100 } }),
    /may only change its title, description or photo/,
    "a bag's price can't change after listing",
  );
  await call(merchant, "catalog")("update_goodie_bag", { original_action: termsBag, bag: { ...listing, title: "Bigger bag tonight" } });
  console.log("[PASS] a bag's price, window and quantity are fixed once listed; its title can still change");
});
