// Proves phase 4 of docs/REPUTATION.md:
//
// - only an order's store, or its driver, rates its customer -- once, on the
//   order completed, a thumbs-down with a reason, naming the store when the
//   store rates, and never once the customer's reported the order; only
//   established raters count, one word each, and a rater who rates most
//   customers down stops counting;
// - a customer's report pattern counts their own reports over their orders;
// - on an order the customer reported, whoever the report is about doesn't
//   rate them on it;
// - a block keeps two parties apart, either way -- carried in the records it
//   applies to: a store's listing (no ordering, no accepting), an order's
//   customer's and store's lists (no feed, no bid: validation refuses it),
//   and each party's own list (no taking a bid, no matching) -- made only by
//   a party to it, and lifted only by whoever made it.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { createHash } from "node:crypto";
import { acceptOrder, actionHash, customerPaid, decodeEntry, retryUntil, retryUntilOk, retryingCaller, setupPlayersWithProperties, ST_PETE, useTestCoordinators } from "./helpers.js";

/// Whether a record's list names `key` -- `handshake_types::block_prints`.
const listsKey = (list: Uint8Array, salt: Uint8Array, key: Uint8Array) => {
  const print = createHash("sha256").update("handshake-block:v1:").update(salt).update(key).digest();
  for (let at = 0; at + 32 <= list.length; at += 32) if (Buffer.from(list.subarray(at, at + 32)).equals(print)) return true;
  return false;
};

interface Score {
  up: number;
  down: number;
  reasons: [string, number][];
  shown: boolean;
}

await runScenario(async (scenario) => {
  // A score shows from one rating; a rater's ratings stop counting once two
  // or more are more than half thumbs-down; a store is established from one
  // completed order.
  const [customer, merchant, driver] = await setupPlayersWithProperties(scenario, 3, () => ({
    min_flagger_orders: 1,
    min_flagger_customers: 1,
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
  const raw = (by: typeof customer, rating: object) => call(by, "reputation")("create_raw_customer_rating_for_testing", { order_ref: first.order, completed: first.done, customer: customer.agentPubKey, up: true, reason: null, store, ...rating });
  await assert.rejects(raw(driver, { store: null }), /only the order's store, or its driver/, "nobody else rates its customer");
  await assert.rejects(raw(merchant, { store: null }), /names its store/, "a store's rating names its store");
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
  const pattern = await retryUntil(() => call(merchant, "dispatch")<{ orders: number; reported: number; upheld: number; shown: boolean }>("get_report_pattern", customer.agentPubKey), (p) => p.reported === 1);
  assert.deepEqual([pattern.reported, pattern.orders >= 2, pattern.shown], [1, true, true], "one reported, of their recent orders");
  assert.equal(pattern.upheld, 0, "none accepted yet");
  console.log("[PASS] a customer's report pattern counts their own reports over their orders, and what stores accepted");

  // ===== A reported order is answered, not rated =====
  const third = await pickup();
  await call(customer, "dispatch")("report_issue", { order: third.order, lines: [{ line: 0, quantity: 1, kind: "Missing" }], note: "", photo_data_uri: "" });
  await sync();
  await retryUntilOk(async () => {
    await assert.rejects(call(merchant, "reputation")("rate_customer", { order: third.order, up: false, reason: "Other" }), /answer their report/);
  });
  const reports = await call(merchant, "dispatch")<{ items: boolean; service: boolean }[]>("reports_on", { customer: customer.agentPubKey, orders: [third.order, first.order] });
  assert.deepEqual(reports, [{ items: true, service: false }, { items: false, service: false }], "what was reported, and about whom");
  console.log("[PASS] a store can't rate a customer on an order they reported it about");

  // ===== A block keeps a customer and a store apart, either way =====
  await assert.rejects(call(driver, "reputation")("block", { by: { Store: store }, blocked: { Person: customer.agentPubKey } }), /as a store you own/, "nobody blocks as a store they don't own");
  const waiting = await place();
  await call(merchant, "reputation")("block", { by: { Store: store }, blocked: { Person: customer.agentPubKey } });
  await sync();
  // The store's listing now names the customer: their app finds itself there.
  await retryUntilOk(async () => {
    await assert.rejects(call(customer, "dispatch")("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000 }), /isn't available to you/);
  });
  const listing = decodeEntry<{ blocked: Uint8Array; block_salt: Uint8Array }>(await call(customer, "catalog")<HcRecord>("get_catalog", store));
  assert.ok(listing.blocked.length >= 32 * 8 && listing.blocked.length % 32 === 0, "padded: the list doesn't tell how many are real");
  assert.ok(listsKey(listing.blocked, listing.block_salt, customer.agentPubKey), "and holds the customer's fingerprint");
  assert.ok(!listsKey(listing.blocked, listing.block_salt, driver.agentPubKey), "and nobody else's");
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: waiting }), /You've blocked this customer/, "nor does the store take an order from them");
  assert.equal((await call(merchant, "reputation")<object[]>("my_blocks", { Store: store })).length, 1, "on the store's own list");
  assert.equal((await call(customer, "reputation")<object[]>("my_blocks", { Person: customer.agentPubKey })).length, 0, "and not on the customer's");
  await call(customer, "reputation")("unblock", { by: { Person: customer.agentPubKey }, blocked: { Store: store } });
  await sync();
  await assert.rejects(call(customer, "dispatch")("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000 }), /isn't available to you/, "only whoever made a block lifts it");
  await call(merchant, "reputation")("unblock", { by: { Store: store }, blocked: { Person: customer.agentPubKey } });
  await sync();
  await place();
  console.log("[PASS] a store blocking a customer keeps them apart either way, from its listing, until the store lifts it");

  // ===== A customer blocking a store =====
  await call(customer, "reputation")("block", { by: { Person: customer.agentPubKey }, blocked: { Store: store } });
  await assert.rejects(call(customer, "dispatch")("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000 }), /You've blocked this store/, "their own list stops them ordering");
  await call(customer, "reputation")("unblock", { by: { Person: customer.agentPubKey }, blocked: { Store: store } });
  console.log("[PASS] a customer blocking a store stops their own ordering, until they lift it");

  // ===== A block keeps a driver and a customer apart, either way =====
  const delivery = actionHash(await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: 1000, tip_cents: 100 }));
  await sync();
  await acceptOrder(merchant, delivery, all);
  const feed = () => call(driver, "dispatch")<HcRecord[]>("get_open_orders_near", storeCell);
  const listed = (records: HcRecord[]) => records.some((record) => decodeEntry<{ requester: Uint8Array }>(record).requester.toString() === customer.agentPubKey.toString());
  await retryUntil(feed, listed);
  const bidRecord = await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: delivery, eta_seconds: 600, price_offer: 500 });
  const bid = actionHash(bidRecord);
  await sync();
  await call(customer, "reputation")("block", { by: { Person: customer.agentPubKey }, blocked: { Person: driver.agentPubKey } });
  // On the order already open: the customer's own list keeps the driver out.
  await assert.rejects(call(customer, "dispatch")("accept_bid", { order_original_action: delivery, bid_action: bid, override_warrants: false }), /You've blocked that driver/, "the customer can't take their bid");
  assert.equal((await call(customer, "dispatch")<object[]>("rank_bids", delivery)).length, 0, "nor is it ranked for matching");
  // On the next: the order carries the block.
  const next = actionHash(await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: 1000, tip_cents: 100 }));
  await sync();
  const opened = await acceptOrder(merchant, next, all);
  const nextOrder = decodeEntry<{ requester: Uint8Array; blocked: Uint8Array; store_blocked: Uint8Array; block_salt: Uint8Array }>(opened);
  assert.ok(listsKey(nextOrder.blocked, nextOrder.block_salt, driver.agentPubKey), "the customer's list names the driver");
  assert.ok(nextOrder.store_blocked.length >= 32 * 8, "and the store's is padded, though it blocked nobody");
  const nextListed = (records: HcRecord[]) => records.some((record) => actionHash(record).toString() === actionHash(opened).toString());
  assert.equal(nextListed(await feed()), false, "the driver's feed leaves it out");
  await assert.rejects(call(driver, "dispatch")("submit_bid", { order_ref: next, eta_seconds: 600, price_offer: 500 }), /isn't available to you/, "their app won't bid");
  const template = decodeEntry<Record<string, unknown>>(bidRecord);
  await assert.rejects(call(driver, "dispatch")("create_raw_bid_for_testing", { ...template, order_ref: actionHash(opened), created_at: Date.now() * 1000 }), /isn't taking bids from this driver/, "and the network refuses one a modified app writes");
  console.log("[PASS] a customer blocking a driver: their own list on the open order, and the next order carries it -- feed, bid, matching");

  // ===== A store blocking a driver =====
  await call(customer, "reputation")("unblock", { by: { Person: customer.agentPubKey }, blocked: { Person: driver.agentPubKey } });
  await call(merchant, "reputation")("block", { by: { Store: store }, blocked: { Person: driver.agentPubKey } });
  const laterDelivery = actionHash(await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: 1000, tip_cents: 100 }));
  await sync();
  const storeOpened = await acceptOrder(merchant, laterDelivery, all);
  const storeOrder = decodeEntry<{ blocked: Uint8Array; store_blocked: Uint8Array; block_salt: Uint8Array }>(storeOpened);
  assert.ok(listsKey(storeOrder.store_blocked, storeOrder.block_salt, driver.agentPubKey) && !listsKey(storeOrder.blocked, storeOrder.block_salt, driver.agentPubKey), "the store's list names the driver, the customer's no longer does");
  await assert.rejects(call(driver, "dispatch")("submit_bid", { order_ref: laterDelivery, eta_seconds: 600, price_offer: 500 }), /isn't available to you/, "the driver can't bid on the store's orders");
  console.log("[PASS] a store blocking a driver: the orders it accepts after carry it");
});
