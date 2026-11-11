// Proves time-bucketed open-order anchors don't
// break ordinary discovery: an order published *now* still lands in the
// *current* bucket and is still found by get_open_orders_near. This is deliberately a modest, 2-conductor test --
// it proves current-bucket read/write correctness live, not the fan-out cap
// under real density (that would need dozens of live driver conductors to
// exercise honestly; the cap's own truncation logic is instead unit-tested
// directly in matching.rs::tests, which is the right tool for a pure,
// deterministic Vec::truncate check). The bucket-boundary math itself
// (two timestamps far enough apart land in different buckets) is unit-
// tested in handshake_types::tests::time_bucket_* -- also not something a live
// Tryorama test should try to prove via clock manipulation.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, appWithProperties, bytesEqual, decodeEntry, ST_PETE, acceptOrder, retryUntil, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  // A feed of two at once, to see it fill oldest first.
  const app = appWithProperties({ max_listed_orders: 2 });
  const [customer, driver] = await scenario.addPlayersWithApps([app, app]);
  const both = [customer, driver];

  const catalogOf = (p: typeof customer) => retryingCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => retryingCaller(p.cells[0], "dispatch");

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", {
    catalog_ref: catalogRef,
    name: "Empanada",
    price_cents: 600,
    available: true,
  });
  const menuItemRef = actionHash(menuItemRecord);

  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 600,
    dropoff: ST_PETE,
    max_delivery_fee: 1_000,
  });
  const orderRef = actionHash(orderRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  // get_open_orders_near takes a geohash directly. An open order is listed
  // under its store's cell; here the store and the drop-off share a spot, so
  // the order's own dropoff_geohash is that cell -- no geohash encoding
  // re-implemented in the test.
  const order = decodeEntry<{ dropoff_geohash: string }>(orderRecord);

  const accepted = await acceptOrder(customer, orderRef, both);
  const openOrders = await dispatchOf(driver)<HcRecord[]>("get_open_orders_near", order.dropoff_geohash);
  assert.equal(openOrders.length, 1, "an order accepted now should be visible via the current-bucket anchor");
  assert.deepEqual(actionHash(openOrders[0]), actionHash(accepted));
  console.log("[PASS] Current-bucket open-order polling backstop still works after time-bucketing the anchor");

  // ===== However busy the area, the feed lists the oldest, up to the network's limit =====
  const place = async () => {
    const record = await dispatchOf(customer)<HcRecord>("request_delivery", { merchant: customer.agentPubKey, catalog_ref: catalogRef, items: [{ item_ref: menuItemRef, quantity: 1 }], order_total: 600, dropoff: ST_PETE, max_delivery_fee: 1_000 });
    await dhtSync(both, customer.cells[0].cell_id[0]);
    return acceptOrder(customer, actionHash(record), both);
  };
  const second = await place();
  const third = await place();
  const feed = () => dispatchOf(driver)<HcRecord[]>("get_open_orders_near", order.dropoff_geohash);
  const listed = await retryUntil(feed, (r) => r.length === 2);
  const has = (records: HcRecord[], version: HcRecord) => records.some((r) => bytesEqual(actionHash(r), actionHash(version)));
  assert.equal(listed.length, 2, "three open, two listed");
  assert.ok(has(listed, accepted) && has(listed, second) && !has(listed, third), "the oldest two");
  // The oldest called off, the next in line is listed.
  await dispatchOf(customer)("cancel_order", orderRef);
  await dhtSync(both, customer.cells[0].cell_id[0]);
  const next = await retryUntil(feed, (r) => has(r, third));
  assert.ok(has(next, second) && has(next, third) && next.length === 2, "the oldest gone, the newest takes its place");
  console.log("[PASS] a driver's feed lists the oldest open orders, up to the network's limit, each in turn");
});
