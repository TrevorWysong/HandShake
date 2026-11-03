// An order's history can branch, and validation sees only the version an
// update changes -- so either side could write as if the other hadn't. What
// settles it is the customer's own chain: their app confirms, by itself, the
// moment it sees the store start (an `OrderConfirmation`). Cancelling before
// that costs nothing, however the store's branch reads; after it, the food
// is the store's, whichever version the customer cancelled on. And a
// customer who cancelled writes nothing more on the order (dispatch_integrity
// `basis::chain_check` and `confirmations`). Forgeries are
// written raw (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, decodeEntry, retryUntil, retryUntilOk, retryingCaller, testApp, useTestCoordinators, customerPaid, holdOf, netOn, payeeAgent } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();
  for (const p of all) await useTestCoordinators(p, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  /// What `p` paid and was paid on `order`, once the store's app has
  /// settled it (and charged what it's owed) -- `times` over.
  const settledTo = async (p: typeof customer, order: Uint8Array, times = 1) => {
    for (let i = 0; i < times; i++) {
      await call(merchant, "dispatch")("settle_order", order).catch(() => 0);
      await payeeAgent(merchant).catch(() => 0);
    }
    await sync();
    return netOn(p, order);
  };

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 900, available: true }));
  await sync();
  const place = () => retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 900 }));

  // ===== Cancelled before the store started: free, whatever the store writes =====
  const early = await place();
  const earlyRef = actionHash(early);
  await sync();
  // The store's agent holds the customer's card before the cancel arrives.
  await customerPaid(merchant, earlyRef, all);
  const food = await holdOf(merchant, earlyRef, "Customer");
  await call(customer, "dispatch")("cancel_pickup_order", earlyRef);
  await sync();
  // A modified store app "accepts" on the version from before the cancel.
  const asPlaced = decodeEntry<Record<string, unknown>>(early);
  await call(merchant, "dispatch")("update_raw_pickup_order_for_testing", { version: earlyRef, order: { ...asPlaced, status: "MerchantConfirmed", ready_by: (Date.now() + 15 * 60_000) * 1000, customer_payment: food } }).catch(() => {});
  await sync();
  assert.equal(await call(customer, "dispatch")("confirm_what_i_saw", earlyRef), null, "a customer who cancelled confirms nothing after");
  // However often the store tries to settle, the food isn't its.
  assert.equal(await settledTo(merchant, earlyRef, 5), 0, "the store isn't paid");
  assert.equal(await settledTo(customer, earlyRef), 0, "nor is the customer charged");
  console.log("[PASS] an order cancelled before the store started costs its customer nothing, whatever the store writes");

  // ===== Cancelled after the app saw the store start: the food is owed =====
  const placed = await place();
  const order = actionHash(placed);
  await sync();
  await customerPaid(merchant, order, all);
  const accepted = await retryUntilOk(() => call(merchant, "dispatch")<HcRecord>("accept_pickup_order", { order_original_action: order }));
  await sync();
  // The customer's app confirms by itself on the store's signal; or here.
  await retryUntil(() => call(customer, "dispatch")("confirm_what_i_saw", order).then(() => call(customer, "dispatch")<boolean>("i_confirmed", order)), (yes) => yes);
  await sync();
  // The customer cancels on the version from before the store accepted.
  const cancel = (version: Uint8Array) => call(customer, "dispatch")("update_raw_pickup_order_for_testing", { version, order: { ...decodeEntry<Record<string, unknown>>(placed), status: "Cancelled", cancellation: "ByCustomer" } });
  await cancel(order);
  await sync();
  await assert.rejects(cancel(actionHash(accepted)), /writes nothing more/, "nor cancel again on the current version");
  await call(merchant, "dispatch")("mark_ready_for_pickup", order);
  await sync();
  await assert.rejects(call(customer, "dispatch")("complete_pickup", order), /writes nothing more/, "a customer who cancelled can't collect it too");
  console.log("[PASS] a customer who cancelled an order writes nothing more on it");

  await retryUntil(() => settledTo(merchant, order), (net) => net === 900, 60, 1000);
  console.log("[PASS] once the customer's app saw the store start, the food is the store's, whichever version they cancelled");

  // ===== A modified app that never confirms, cancelling on what it saw =====
  // Writing on the store's started version is seeing it: no confirmation
  // needed for the food to be owed.
  const third = await place();
  const thirdRef = actionHash(third);
  await sync();
  await customerPaid(merchant, thirdRef, all);
  const thirdAccepted = await retryUntilOk(() => call(merchant, "dispatch")<HcRecord>("accept_pickup_order", { order_original_action: thirdRef }));
  await sync();
  await call(customer, "dispatch")("update_raw_pickup_order_for_testing", { version: actionHash(thirdAccepted), order: { ...decodeEntry<Record<string, unknown>>(thirdAccepted), status: "Cancelled", cancellation: "ByCustomer" } });
  await sync();
  await retryUntil(() => settledTo(merchant, thirdRef), (net) => net === 900, 60, 1000);
  console.log("[PASS] cancelling on the store's started version owes the food, confirmed or not");
});
