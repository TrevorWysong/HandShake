// Proves holds end to end, with the customer, store and driver all
// different agents: each step of a delivery needs the hold its payee makes
// on its payer's card -- the store holds the customer's, the store holds the
// driver's collateral, the driver holds the store's for their pay -- and
// nothing is charged until the customer confirms the delivery; then each
// payee charges what it's owed and releases the rest. A cancellation
// charges only what somebody earned: nothing before the store accepts; once
// a driver is paid for, the customer's share of their fee; and once the
// store is cooking, the food too.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, collectFromStore, commitAndCook, driverPaid, handOff, netOn, paymentsOn, payeeAgent, retryUntilOk, settleAll, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, merchant, driver];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  /// What's held on `order`, leg by leg.
  const held = async (order: Uint8Array) => Object.fromEntries((await paymentsOn(customer, order)).map((p) => [typeof p.leg === "string" ? p.leg : Object.keys(p.leg)[0], p.held]));
  const nets = async (order: Uint8Array) => [await netOn(customer, order), await netOn(merchant, order), await netOn(driver, order)];

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  // The store covers half the delivery fee (the default).
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 2000, available: true }));
  await sync();
  const placeOrder = async () => {
    const order = actionHash(
      await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: 2000, dropoff: ST_PETE, max_delivery_fee: 1_000, tip_cents: 300 }),
    );
    await sync();
    return order;
  };
  const assignDriver = async (order: Uint8Array) => {
    await acceptOrder(merchant, order, all);
    const bid = actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: 500 }));
    await sync();
    await call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: bid });
    await sync();
  };

  // --- A delivery, step by step. ---
  const order = await placeOrder();
  assert.deepEqual(await held(order), {}, "placing the order holds nothing until the store's agent holds the card");
  await assignDriver(order);
  assert.deepEqual(await held(order), { Customer: 2000 + 500 + 300 }, "the store holds the food, the customer's share of the fee at their cap, and the tip");
  await commitAndCook(driver, merchant, order, all);
  assert.deepEqual(await held(order), { Customer: 2800, Collateral: 2000, DriverPay: 500 + 300 }, "committing needs the driver's collateral held by the store, and their bid and the tip held by them on the store's card");
  await collectFromStore(driver, merchant, order, all);
  await sync();
  for (const p of all) {
    assert.equal(await call(p, "dispatch")<number>("settle_order", order), 0, "nothing is owed to anyone before the customer has the order");
    assert.equal(await payeeAgent(p), 0, "so nothing is charged");
  }
  console.log("[PASS] each step needs its hold, and nothing is charged before the delivery");

  await handOff(driver, customer, order, "CustomerHandoff", all);
  await retryUntilOk(() => call(customer, "dispatch")("complete_delivery", { order_original_action: order }));
  await sync();
  await settleAll(all, order);
  assert.deepEqual(await nets(order), [-(2000 + 250 + 300), 2000 - 250, 500 + 300], "the customer pays the food, half the fee and the tip; the driver is paid the whole fee and the tip, and their collateral released");
  console.log("[PASS] once the customer confirms, each payee charges what it's owed");

  // --- A customer cancelling before the store accepts pays nothing. ---
  const early = await placeOrder();
  await call(customer, "dispatch")("cancel_order", early);
  await sync();
  await settleAll(all, early);
  assert.deepEqual(await nets(early), [0, 0, 0], "nothing is charged");
  console.log("[PASS] cancelling before the store accepts charges nothing");

  // --- With a driver assigned but nothing cooking, only the driver's fee is owed. ---
  const assigned = await placeOrder();
  await assignDriver(assigned);
  // A store paying its driver as soon as they're assigned (its card saved with them).
  await driverPaid(merchant, driver, assigned, all);
  await retryUntilOk(() => call(customer, "dispatch")("cancel_order", assigned));
  await sync();
  await settleAll(all, assigned);
  assert.deepEqual(await nets(assigned), [-250, 0, 250], "the driver is paid the customer's half of the fee, passed on by the store; the food and the tip are released");
  console.log("[PASS] cancelling before the store cooks costs only the driver's fee");

  // --- Once it's cooking, the store keeps the food too. ---
  const late = await placeOrder();
  await assignDriver(late);
  await commitAndCook(driver, merchant, late, all);
  await retryUntilOk(() => call(customer, "dispatch")("cancel_order", late));
  await sync();
  await settleAll(all, late);
  assert.deepEqual(await nets(late), [-(2000 + 250), 2000, 250], "the store keeps the food, the driver the customer's half of the fee and their collateral back; the tip is released");
  console.log("[PASS] a late cancellation pays the store and driver for what they'd committed, and releases the rest");
});
