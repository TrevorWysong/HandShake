// Proves phase 4 of docs/REPUTATION.md:
//
// - only an order's store, or its driver, rates its customer -- once, on the
//   order completed, a thumbs-down with a reason; a rater who rates most
//   customers down stops counting;
// - a customer's report pattern counts their own reports over their orders;
// - a block, either way, keeps two parties apart -- ordering, a store taking
//   an order, a driver's feed and bid, a customer taking a bid -- made only
//   by a party to it, and lifted by whoever made it.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, customerPaid, decodeEntry, retryUntil, retryUntilOk, retryingCaller, setupPlayersWithProperties, ST_PETE, useTestCoordinators } from "./helpers.js";

interface Score {
  up: number;
  down: number;
  reasons: [string, number][];
  shown: boolean;
}

await runScenario(async (scenario) => {
  // A score shows from one rating; a rater's ratings stop counting once two
  // or more are more than half thumbs-down.
  const [customer, merchant, driver] = await setupPlayersWithProperties(scenario, 3, () => ({
    min_customer_ratings: 1,
    min_rater_ratings: 2,
    max_rater_down_percent: 50,
    min_report_pattern_orders: 1,
  }));
  const all = [customer, merchant, driver];
  for (const p of all) await useTestCoordinators(p, ["dispatch", "reputation"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const catalog = await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE });
  const store = actionHash(catalog);
  // A driver's feed is read by the store's area.
  const storeCell = decodeEntry<{ geohash: string }>(catalog).geohash.slice(0, 6);
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 1000, available: true }));
  await sync();

  const place = async () => {
    const order = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000 })));
    await sync();
    return order;
  };
  const pickup = async () => {
    const order = await place();
    await customerPaid(merchant, order, all);
    await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order }));
    await call(merchant, "dispatch")("mark_ready_for_pickup", order);
    await sync();
    const done = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("complete_pickup", order), 40));
    await sync();
    return { order, done };
  };
  const score = () => call(driver, "reputation")<Score>("get_customer_score", customer.agentPubKey);

  // ===== Rating a customer: who, on what, once =====
  const first = await pickup();
  const raw = (by: typeof customer, rating: object) => call(by, "reputation")("create_raw_customer_rating_for_testing", { order_ref: first.order, completed: first.done, customer: customer.agentPubKey, up: true, reason: null, ...rating });
  await assert.rejects(raw(driver, {}), /only the order's store, or its driver/, "nobody else rates its customer");
  await assert.rejects(raw(merchant, { up: false }), /thumbs-down gives a reason/, "a thumbs-down gives a reason");
  await assert.rejects(raw(merchant, { reason: "Unsafe" }), /thumbs-up none/, "a thumbs-up gives none");
  await assert.rejects(raw(merchant, { completed: first.order }), /completed/, "only on the order completed");
  await call(merchant, "reputation")("rate_customer", { order: first.order, up: false, reason: "Unreachable" });
  await assert.rejects(call(merchant, "reputation")("rate_customer", { order: first.order, up: true, reason: null }), /already rated/, "once");
  await assert.rejects(raw(merchant, {}), /rated once per order/, "nor can a modified app rate twice");
  await sync();
  const rated = await retryUntil(score, (s) => s.down === 1);
  assert.deepEqual([rated.up, rated.down, rated.shown, rated.reasons], [0, 1, true, [["Unreachable", 1]]], "counted, with its reason, and shown");
  console.log("[PASS] only the order's store or driver rates its customer, once, a thumbs-down with a reason");

  // ===== A rater who rates most customers down stops counting =====
  const second = await pickup();
  await call(merchant, "reputation")("rate_customer", { order: second.order, up: false, reason: "RudeOrAbusive" });
  await sync();
  const unfair = await retryUntil(score, (s) => s.down === 0);
  assert.deepEqual([unfair.up, unfair.down, unfair.shown], [0, 0, false], "two of two thumbs-down: none of that rater's count");
  console.log("[PASS] a rater who rates most customers down counts for nothing");

  // ===== The customer's report pattern =====
  await call(customer, "dispatch")("report_issue", { order: second.order, lines: [{ line: 0, quantity: 1, kind: "Missing" }], note: "", photo_data_uri: "" });
  await sync();
  const pattern = await retryUntil(() => call(merchant, "dispatch")<{ orders: number; reported: number; shown: boolean }>("get_report_pattern", customer.agentPubKey), (p) => p.reported === 1);
  assert.deepEqual([pattern.reported, pattern.orders >= 2, pattern.shown], [1, true, true], "one reported, of their recent orders");
  console.log("[PASS] a customer's report pattern counts their own reports over their orders");

  // ===== A block keeps a customer and a store apart, either way =====
  await assert.rejects(call(driver, "reputation")("block", { by: { Store: store }, blocked: { Person: customer.agentPubKey } }), /made by the person, or the store's owner/, "nobody blocks as a store they don't own");
  const waiting = await place();
  await call(merchant, "reputation")("block", { by: { Store: store }, blocked: { Person: customer.agentPubKey } });
  await sync();
  await assert.rejects(call(customer, "dispatch")("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000 }), /isn't available to you/, "the customer can't order from it");
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: waiting }), /blocked each other/, "nor the store take an order from them");
  const [blocked] = await call(customer, "reputation")<boolean[]>("blocked_pairs", [[{ Person: customer.agentPubKey }, { Store: store }]]);
  assert.equal(blocked, true, "the customer's app sees it, whichever made it");
  assert.equal((await call(merchant, "reputation")<object[]>("my_blocks", { Store: store })).length, 1, "on the store's own list");
  assert.equal((await call(customer, "reputation")<object[]>("my_blocks", { Person: customer.agentPubKey })).length, 0, "and not on the customer's");
  await call(customer, "reputation")("unblock", { by: { Person: customer.agentPubKey }, blocked: { Store: store } });
  await sync();
  assert.equal((await call(customer, "reputation")<boolean[]>("blocked_pairs", [[{ Person: customer.agentPubKey }, { Store: store }]]))[0], true, "only whoever made a block lifts it");
  await call(merchant, "reputation")("unblock", { by: { Store: store }, blocked: { Person: customer.agentPubKey } });
  await sync();
  await retryUntil(() => call(customer, "reputation")<boolean[]>("blocked_pairs", [[{ Person: customer.agentPubKey }, { Store: store }]]), (b) => b[0] === false);
  await place();
  console.log("[PASS] a store blocking a customer keeps them apart either way, until the store lifts it");

  // ===== A block keeps a driver and a customer apart, either way =====
  const delivery = actionHash(await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: 1000, tip_cents: 100 }));
  await sync();
  await acceptOrder(merchant, delivery, all);
  const feed = () => call(driver, "dispatch")<HcRecord[]>("get_open_orders_near", storeCell);
  const listed = (records: HcRecord[]) => records.some((record) => decodeEntry<{ requester: Uint8Array }>(record).requester.toString() === customer.agentPubKey.toString());
  await retryUntil(feed, listed);
  const bid = actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: delivery, eta_seconds: 600, price_offer: 500 }));
  await sync();
  await call(customer, "reputation")("block", { by: { Person: customer.agentPubKey }, blocked: { Person: driver.agentPubKey } });
  await sync();
  assert.equal(listed(await feed()), false, "the driver no longer sees the customer's orders");
  await assert.rejects(call(customer, "dispatch")("accept_bid", { order_original_action: delivery, bid_action: bid, override_warrants: false }), /isn't available for this order/, "nor the customer take their bid");
  const ranked = await call(customer, "dispatch")<object[]>("rank_bids", delivery);
  assert.equal(ranked.length, 0, "nor is it ranked for matching");
  console.log("[PASS] a customer blocking a driver keeps them apart: feed, bid and matching");
});
