// Free delivery from an order size up, paid for end to end, with the
// customer, store and driver all different agents. An order past the
// store's free-delivery tier holds the customer's card for the food and
// the tip alone -- no fee -- and once delivered the store pays the driver's
// whole bid; one short of it holds and pays the customer's share, as
// always. Settling again changes nothing.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, bytesEqual, collectFromStore, commitAndCook, customerPaid, decodeEntry, handOff, netOn, paymentsOn, payeeAgent, settleAll, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, merchant, driver];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const plate = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Plate", price_cents: 600, available: true }));
  const side = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Side", price_cents: 400, available: true }));
  // Half of every fee, and all of it from $5 of food.
  await call(merchant, "catalog")("set_delivery_subsidy_percent", { original_action: store, delivery_subsidy_percent: 50, delivery_subsidy_tiers: [{ from_cents: 500, percent: 100 }] });
  await sync();

  const deliver = (item: Uint8Array, total: number) =>
    call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: total, dropoff: ST_PETE, max_delivery_fee: 1_000, tip_cents: 100 });
  const freeRecord = await deliver(plate, 600);
  const shortRecord = await deliver(side, 400);
  const free = actionHash(freeRecord);
  const short = actionHash(shortRecord);
  assert.equal(decodeEntry<{ delivery_subsidy_percent: number }>(freeRecord).delivery_subsidy_percent, 100);
  assert.equal(decodeEntry<{ delivery_subsidy_percent: number }>(shortRecord).delivery_subsidy_percent, 50);
  await sync();

  // ===== The customer's card, held for exactly what each order needs =====
  const customerHold = async (order: Uint8Array) => (await paymentsOn(merchant, order)).find((p) => p.leg === "Customer" && bytesEqual(p.payer, customer.agentPubKey));
  await customerPaid(merchant, free, all);
  await customerPaid(merchant, short, all);
  assert.equal((await customerHold(free))?.held, 600 + 100, "free delivery: the food and the tip, no fee");
  assert.equal((await customerHold(short))?.held, 400 + 500 + 100, "short of it: the food, half the fee at its cap, and the tip");
  console.log("[PASS] a free-delivery order holds the customer's card for the food and the tip alone");

  // ===== Delivered, and paid for =====
  await acceptOrder(merchant, free, all);
  const bid = actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: free, eta_seconds: 600, price_offer: 500 }));
  await sync();
  await call(customer, "dispatch")("accept_bid", { order_original_action: free, bid_action: bid });
  await sync();
  await commitAndCook(driver, merchant, free, all);
  await collectFromStore(driver, merchant, free, all);
  await handOff(driver, customer, free, "CustomerHandoff", all);
  await sync();
  await call(customer, "dispatch")("complete_delivery", { order_original_action: free });
  await sync();
  await settleAll(all, free);
  assert.equal(await netOn(customer, free), -(600 + 100), "the customer pays the food and the tip, and nothing for delivery");
  assert.equal(await netOn(driver, free), 500 + 100, "the driver gets the whole $5.00 fee and the tip");
  assert.equal(await netOn(merchant, free), 600 - 500, "the store is paid for the food and pays the whole fee");
  console.log("[PASS] once delivered, the store pays the driver's whole fee and the customer none of it");

  for (const p of all) {
    assert.equal(await call(p, "dispatch")<number>("settle_order", free), 0, "settling again finds nothing left");
    assert.equal(await payeeAgent(p), 0, "nor anything left to charge");
  }
  assert.equal(await netOn(customer, free), -(600 + 100), "and changes nothing");
  console.log("[PASS] once settled, settling again is a no-op for everyone");
});
