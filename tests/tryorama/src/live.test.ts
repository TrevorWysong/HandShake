// Proves what chat and live location rest on (dispatch's live.rs, the
// app's holochain/live.ts): each end learns its counterpart on an order --
// only once a driver is assigned, and only if it's on the order -- and
// every device accepts direct signals, which travel app to app with the
// sender vouched for by the network. What a screen does with one (check
// it against the counterpart) is the app's.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { DirectSignal, Record as HcRecord, Signal } from "@holochain/client";
import { actionHash, ST_PETE, acceptOrder, testApp, retryingCaller } from "./helpers.js";

/// The first direct signal `ws` hears, or null after `timeoutMs`.
function nextDirectSignal(ws: { on: (evt: "signal", cb: (s: Signal) => void) => () => void }, timeoutMs: number): Promise<DirectSignal | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, timeoutMs);
    const unsubscribe = ws.on("signal", (signal) => {
      if (signal.type !== "app_direct") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(signal.value);
    });
  });
}

await runScenario(async (scenario) => {
  const [customer, driver, stranger] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, driver, stranger];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => retryingCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => retryingCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => retryingCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });
  await profilesOf(stranger)("create_profile", { display_name: "Sam Stranger", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true });
  const menuItemRef = actionHash(menuItemRecord);

  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 600,
    dropoff: ST_PETE,
    max_delivery_fee: null,
  });
  const orderRef = actionHash(orderRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await acceptOrder(customer, orderRef, all);

  await assert.rejects(dispatchOf(driver)("live_counterpart", orderRef), /This order has no driver yet/, "there's no counterpart before a driver is assigned");
  console.log("[PASS] no counterpart before a driver is assigned");

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", { order_ref: orderRef, eta_seconds: 600, price_offer: 400 });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: actionHash(bidRecord) });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  type Counterpart = { counterpart: Uint8Array; role: string; counterpart_role: string };
  const forCustomer = await dispatchOf(customer)<Counterpart>("live_counterpart", orderRef);
  assert.deepEqual([...forCustomer.counterpart], [...driver.agentPubKey], "the customer's counterpart is the driver");
  assert.deepEqual([forCustomer.role, forCustomer.counterpart_role], ["Customer", "Driver"]);
  const forDriver = await dispatchOf(driver)<Counterpart>("live_counterpart", orderRef);
  assert.deepEqual([...forDriver.counterpart], [...customer.agentPubKey], "the driver's counterpart is the customer");
  assert.deepEqual([forDriver.role, forDriver.counterpart_role], ["Driver", "Customer"]);
  console.log("[PASS] customer and driver each learn the other, and their side");

  await assert.rejects(dispatchOf(stranger)("live_counterpart", orderRef), /Only this order's customer and its driver can chat about it/, "someone not on the order has no counterpart on it");
  console.log("[PASS] someone not on the order has no counterpart on it");

  // A pickup's customer and its store talk to each other -- and on a pickup
  // nobody is a driver, so neither side's location is ever heard.
  const shop = actionHash(await catalogOf(driver)<HcRecord>("publish_catalog", { business_name: "Dana's Deli", location: ST_PETE }));
  const sandwich = actionHash(await catalogOf(driver)<HcRecord>("add_menu_item", { catalog_ref: shop, name: "Cubano", price_cents: 900, available: true }));
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const pickupRef = actionHash(await dispatchOf(customer)<HcRecord>("request_pickup_order", { merchant: driver.agentPubKey, catalog_ref: shop, items: [{ item_ref: sandwich, quantity: 1 }], order_total: 900, promo_code_ref: null }));
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const customerSide = await dispatchOf(customer)<Counterpart>("live_counterpart", pickupRef);
  assert.deepEqual([...customerSide.counterpart], [...driver.agentPubKey], "the customer's counterpart is the store");
  assert.deepEqual([customerSide.role, customerSide.counterpart_role], ["Customer", "Store"]);
  const storeSide = await dispatchOf(driver)<Counterpart>("live_counterpart", pickupRef);
  assert.deepEqual([...storeSide.counterpart], [...customer.agentPubKey], "the store's counterpart is the customer");
  assert.deepEqual([storeSide.role, storeSide.counterpart_role], ["Store", "Customer"]);
  await assert.rejects(dispatchOf(stranger)("live_counterpart", pickupRef), /Only this order's customer and its store can chat about it/);
  console.log("[PASS] a pickup's customer and store learn each other, and nobody else is on it");

  // Each device granted direct signals as it started (prepare_device), so
  // both directions arrive, with the sender as the network saw it.
  const dnaHash = customer.cells[0].cell_id[0];
  for (const [from, to] of [
    [driver, customer],
    [customer, driver],
  ] as const) {
    const bytes = new Uint8Array([1, 2, 3, from === driver ? 4 : 5]);
    const arrived = nextDirectSignal(to.appWs, 10_000);
    await from.appWs.sendDirectSignal({ dna_hash: dnaHash, agents: [to.agentPubKey], signal: bytes });
    const signal = await arrived;
    assert.ok(signal, "the direct signal should arrive");
    assert.deepEqual([...signal.from_agent], [...from.agentPubKey], "it names its sender");
    assert.deepEqual([...signal.signal], [...bytes], "it carries what was sent");
  }
  console.log("[PASS] direct signals arrive both ways, naming their sender");
});
