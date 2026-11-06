// Sale prices: a lower price a store sets, now or on a schedule. An order's total
// is worked out at it, and a line can't claim one its item doesn't have, or one
// that isn't running: validation checks the dates, and the store the week.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, customerPaid, decodeEntry, retryUntilOk, retryingCaller, ST_PETE, testApp, useTestCoordinators } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, store, stranger] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, store, stranger];
  await scenario.shareAllAgents();
  await useTestCoordinators(customer, ["dispatch"]);
  const sync = (from = store) => dhtSync(all, from.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(store, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const shop = actionHash(await call(store, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const burger = { catalog_ref: shop, name: "Burger", price_cents: 1000, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [], modifier_groups: [] };
  const sale = { price_cents: 700, label: "Happy hour", starts_at: null, ends_at: null, weekly: [] };
  const add = (over: Record<string, unknown>) => call(store, "catalog")<HcRecord>("add_menu_item", { ...burger, ...over });

  // ===== A store's sale, in a shape that makes sense =====
  await assert.rejects(add({ sale: { ...sale, price_cents: 1000 } }), /less than the item's price/, "a sale is lower");
  await assert.rejects(add({ sale: { ...sale, price_cents: 0 } }), /more than nothing/, "and it's more than nothing");
  await assert.rejects(add({ sale: { ...sale, starts_at: now + 10, ends_at: now } }), /ends after it starts/);
  await assert.rejects(add({ sale: { ...sale, weekly: [{ weekday: 7, opens: 0, closes: 60 }] } }), /weekday/);
  await assert.rejects(add({ sale: { ...sale, label: "x".repeat(61) } }), /name/);
  await assert.rejects(call(stranger, "catalog")("add_menu_item", { ...burger, sale }), /./, "nobody sets a sale on someone else's menu");
  console.log("[PASS] a sale is lower than its item's price, and its store's to set");

  const always = actionHash(await add({ sale }));
  const weekday = new Date().getUTCDay();
  const elsewhen = actionHash(await add({ name: "Wings", sale: { ...sale, weekly: [{ weekday: (weekday + 3) % 7, opens: 0, closes: 60 }] } }));
  const ended = actionHash(await add({ name: "Soup", sale: { ...sale, ends_at: now - 86_400_000_000 } }));
  const plain = actionHash(await add({ name: "Fries" }));
  await sync();
  const place = (item: Uint8Array, order_total: number) => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: store.agentPubKey, catalog_ref: shop, items: [{ item_ref: item, quantity: 2 }], order_total });

  // ===== Placed at the price it's running at =====
  const onSale = await place(always, 1400);
  assert.equal(decodeEntry<{ lines: { on_sale: boolean }[] }>(onSale).lines[0].on_sale, true);
  await assert.rejects(place(always, 2000), /prices have changed/, "not at its full price while it's on sale");
  const [line] = await call(customer, "dispatch")<{ unit_price_cents: number; on_sale: boolean }[]>("get_order_lines", actionHash(onSale));
  assert.deepEqual([line.unit_price_cents, line.on_sale], [700, true], "its line reads as what was paid");
  assert.equal(decodeEntry<{ lines: { on_sale: boolean }[] }>(await place(elsewhen, 2000)).lines[0].on_sale, false, "a sale for another day isn't running");
  assert.equal(decodeEntry<{ lines: { on_sale: boolean }[] }>(await place(ended, 2000)).lines[0].on_sale, false, "nor one that's over");
  console.log("[PASS] an order's priced at the sale that's running, and only then");

  // ===== A modified app claiming what isn't so =====
  const raw = (item: Uint8Array, on_sale: boolean, order_total: number) =>
    call(customer, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey, merchant: store.agentPubKey, catalog_ref: shop, catalog_version: shop,
      lines: [{ item_ref: item, priced_version: item, quantity: 1, on_sale }], order_total, status: "Placed", requested_at: Date.now() * 1000,
      kitchen_note: null, promo_code_ref: null, loyalty_proof: [],
    });
  await assert.rejects(raw(plain, true, 700), /claim a sale its item had running/, "a sale its item doesn't have");
  await assert.rejects(raw(ended, true, 700), /claim a sale its item had running/, "one that's over, by its dates");
  await assert.rejects(raw(always, false, 700), /order_total must be 1000/, "a sale's price without claiming it");
  await assert.rejects(raw(always, true, 500), /order_total must be 700/, "less than the sale's price");
  console.log("[PASS] validation refuses a line claiming a sale it can't have, or any other price");

  // A week's schedule needs a time zone, which validation hasn't got: the claim
  // gets onto the network, and the store won't take it.
  const forged = actionHash(await raw(elsewhen, true, 700));
  await sync(customer);
  await customerPaid(store, forged, all);
  await assert.rejects(call(store, "dispatch")("accept_pickup_order", { order_original_action: forged }), /outdated menu/, "a store won't take a sale that isn't running");
  console.log("[PASS] a store refuses an order claiming a weekly sale outside its times");

  // An honest one is taken, and what it pays is what its refund's worth.
  const honest = actionHash(onSale);
  await sync(customer);
  await customerPaid(store, honest, all);
  await retryUntilOk(() => call(store, "dispatch")("accept_pickup_order", { order_original_action: honest }));
  console.log("[PASS] a store takes an order at the sale that's running");
});
