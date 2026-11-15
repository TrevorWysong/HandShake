// A store's share of the delivery fee by order size -- "free delivery on
// orders $25+" is one tier of 100% -- and promo codes for deliveries only
// or pickups only. Each order records the share for its size, and
// validation refuses any other; a code the wrong way is refused, by the
// app plainly and by validation whatever the app says.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, ST_PETE, testApp, useTestCoordinators, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [merchant, customer] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [merchant, customer];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof merchant, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const plate = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Plate", price_cents: 1000, available: true }));

  // ===== The store's tiers, as validation allows them =====
  const share = (base: number, tiers: { from_cents: number; percent: number }[]) =>
    call(merchant, "catalog")<HcRecord>("set_delivery_subsidy_percent", { original_action: store, delivery_subsidy_percent: base, delivery_subsidy_tiers: tiers });
  await assert.rejects(share(50, [{ from_cents: 2500, percent: 40 }]), /bigger than the last, and covered more/, "a tier covers more than the base");
  await assert.rejects(share(50, [{ from_cents: 2500, percent: 100 }, { from_cents: 1500, percent: 75 }]), /bigger than the last/, "smallest first");
  await assert.rejects(share(50, [1, 2, 3, 4, 5].map((n) => ({ from_cents: n * 1000, percent: 50 + n * 5 }))), /bigger than the last/, "at most four");
  const tiered = await share(50, [{ from_cents: 2500, percent: 100 }]);
  assert.deepEqual(decodeEntry<{ delivery_subsidy_tiers: unknown }>(tiered).delivery_subsidy_tiers, [{ from_cents: 2500, percent: 100 }]);
  await sync();
  console.log("[PASS] a store covers more of delivery on bigger orders, within the network's rules");

  // ===== Each order records the share for its size =====
  const deliver = (quantity: number) =>
    call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: plate, quantity }], order_total: 1000 * quantity, dropoff: ST_PETE, max_delivery_fee: 800 });
  const small = await deliver(2);
  const large = await deliver(3);
  const percentOf = (record: HcRecord) => decodeEntry<{ delivery_subsidy_percent: number }>(record).delivery_subsidy_percent;
  assert.equal(percentOf(small), 50, "$20: the base share");
  assert.equal(percentOf(large), 100, "$30: free delivery");
  console.log("[PASS] an order records its store's share for an order its size");

  // A modified client can't claim another share for its size.
  await useTestCoordinators(customer, ["dispatch"]);
  const forged = (template: HcRecord, fields: Record<string, unknown>) => call(customer, "dispatch")("create_raw_delivery_order_for_testing", { template: actionHash(template), ...fields });
  await assert.rejects(forged(small, { delivery_subsidy_percent: 100 }), /fee split is its store's, for an order its size/, "free delivery on an order short of it");
  await assert.rejects(forged(large, { delivery_subsidy_percent: 50 }), /fee split is its store's, for an order its size/, "nor less than the store offers");
  assert.ok(await forged(large, {}), "the honest copy is valid");
  console.log("[PASS] validation refuses a share that isn't the store's for the order's size");

  // ===== A code for one way of getting an order =====
  const promo = async (name: string, only: "Delivery" | "Pickup" | null) =>
    actionHash(
      await call(merchant, "catalog")<HcRecord>("create_promo_code", {
        catalog_ref: store,
        code: name,
        requirement: "None",
        reward: { PercentOffSubtotal: 10 },
        limits: { first_order_only: false, only, per_customer: null, once_per: null, total: null },
      }),
    );
  const pickupOnly = await promo("PICKUP10", "Pickup");
  const deliveryOnly = await promo("DELIVER10", "Delivery");
  await sync();
  const order = (kind: "request_delivery" | "request_pickup_order", promoRef: Uint8Array) =>
    call(customer, "dispatch")<HcRecord>(kind, {
      merchant: merchant.agentPubKey,
      catalog_ref: store,
      items: [{ item_ref: plate, quantity: 1 }],
      order_total: 900,
      promo_code_ref: promoRef,
      ...(kind === "request_delivery" ? { dropoff: ST_PETE, max_delivery_fee: 800 } : {}),
    });
  await assert.rejects(order("request_delivery", pickupOnly), /PICKUP10 is for pickup orders only/, "told plainly, with what to do");
  await assert.rejects(order("request_pickup_order", deliveryOnly), /DELIVER10 is for delivery orders only/);
  assert.ok(await order("request_pickup_order", pickupOnly), "a pickup code on a pickup");
  assert.ok(await order("request_delivery", deliveryOnly), "a delivery code on a delivery");
  // And whatever the app says: a delivery citing a code for pickups.
  await assert.rejects(forged(small, { promo_code_ref: pickupOnly }), /promo code is for pickup orders only/, "validation refuses it");
  console.log("[PASS] a promo code for deliveries or pickups only is used only that way");
});
