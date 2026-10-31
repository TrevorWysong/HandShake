// An order's history can branch, and validation sees only the version an
// update changes -- so either side could write as if the other hadn't. What
// settles it is the customer's own chain: their app confirms, by itself, the
// moment it sees the store start (an `OrderConfirmation`). Cancelling before
// that costs nothing, however the store's branch reads; after it, the food
// is the store's, whichever version the customer cancelled on. And a
// customer who cancelled writes nothing more on the order (ledger_integrity
// `confirmed_cooking`, dispatch_integrity `confirmations`). Forgeries are
// written raw (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, decodeEntry, retryUntil, retryUntilOk, retryingCaller, testApp, useTestCoordinators } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();
  for (const p of all) await useTestCoordinators(p, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 900, available: true }));
  await sync();
  const place = () => retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 900 }));

  // ===== Cancelled before the store started: free, whatever the store writes =====
  const customerStart = await balance(customer);
  const storeStart = await balance(merchant);
  const early = await place();
  const earlyRef = actionHash(early);
  await sync();
  const holds = await retryUntil(() => call(customer, "ledger")<{ hold: ActionHash; purpose: string }[]>("holds_for_order", earlyRef), (h) => h.some((x) => x.purpose === "Food"));
  await call(customer, "dispatch")("cancel_pickup_order", earlyRef);
  await sync();
  // A modified store app "accepts" on the version from before the cancel.
  const asPlaced = decodeEntry<Record<string, unknown>>(early);
  const food = holds.find((x) => x.purpose === "Food")!.hold;
  await call(merchant, "dispatch")("update_raw_pickup_order_for_testing", { version: earlyRef, order: { ...asPlaced, status: "MerchantConfirmed", ready_by: (Date.now() + 15 * 60_000) * 1000, food_hold: food } }).catch(() => {});
  await sync();
  assert.equal(await call(customer, "dispatch")("confirm_what_i_saw", earlyRef), null, "a customer who cancelled confirms nothing after");
  // However often the store tries to settle, the food isn't its.
  for (let i = 0; i < 5; i++) await call(merchant, "dispatch")("settle_order", earlyRef).catch(() => {});
  await sync();
  assert.equal(await balance(merchant), storeStart, "the store isn't paid");
  await retryUntil(() => call(customer, "dispatch")("settle_order", earlyRef).catch(() => 0).then(() => balance(customer)), (b) => b === customerStart, 60, 1000);
  console.log("[PASS] an order cancelled before the store started costs its customer nothing, whatever the store writes");

  // ===== Cancelled after the app saw the store start: the food is owed =====
  const placed = await place();
  const order = actionHash(placed);
  await sync();
  const accepted = await retryUntilOk(() => call(merchant, "dispatch")<HcRecord>("accept_pickup_order", { order_original_action: order }));
  await sync();
  // The customer's app confirms by itself on the store's signal; or here.
  await retryUntil(() => call(customer, "dispatch")("confirm_what_i_saw", order).then(() => call(customer, "dispatch")<boolean>("i_confirmed", order)), (yes) => yes);
  await sync();
  const storeBefore = await balance(merchant);
  // The customer cancels on the version from before the store accepted.
  const cancel = (version: Uint8Array) => call(customer, "dispatch")("update_raw_pickup_order_for_testing", { version, order: { ...decodeEntry<Record<string, unknown>>(placed), status: "Cancelled", cancellation: "ByCustomer" } });
  await cancel(order);
  await sync();
  await assert.rejects(cancel(actionHash(accepted)), /writes nothing more/, "nor cancel again on the current version");
  await call(merchant, "dispatch")("mark_ready_for_pickup", order);
  await sync();
  await assert.rejects(call(customer, "dispatch")("complete_pickup", order), /writes nothing more/, "a customer who cancelled can't collect it too");
  console.log("[PASS] a customer who cancelled an order writes nothing more on it");

  await retryUntil(() => call(merchant, "dispatch")("settle_order", order).then(() => balance(merchant)), (b) => b === storeBefore + 900, 60, 1000);
  console.log("[PASS] once the customer's app saw the store start, the food is the store's, whichever version they cancelled");
});
