// Goodie bags, ordered as lines of ordinary orders (catalog_types::GoodieBag,
// dispatch's `bags`). What no client can get around:
//
// - a bag line is one bag, at the bag's own price, taxed with the order,
//   from its own store, placed before its window closes, had a way the bag
//   is offered, and never by its own store;
// - a customer has each bag once -- unless that order came to nothing
//   before the store took it on;
// - only the store's acceptance sells a bag, never past its quantity, and
//   only the store records a sale;
// - promo codes and rewards are the menu's, not a bag's.
//
// Orders written raw (create_raw_pickup_order_for_testing) are what a
// modified client could do: every refusal of one comes from validation.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, retryUntil, retryUntilOk, ST_PETE, testApp, retryingCaller, useTestCoordinators, customerPaid } from "./helpers.js";

interface Standing {
  left: number;
  ordered: boolean;
}

await runScenario(async (scenario) => {
  const [merchant, cara, bo] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [merchant, cara, bo];
  await scenario.shareAllAgents();
  for (const player of all) await useTestCoordinators(player, ["dispatch"]);
  const sync = () => dhtSync(all, merchant.cells[0].cell_id[0]);
  const call = (p: typeof merchant, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(cara, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(bo, "profiles")("create_profile", { display_name: "Bo", roles: ["Requester", "Merchant"], created_at: now });
  const published = await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const store = actionHash(published);
  await call(merchant, "catalog")("set_tax_settings", { original_action: store, tax_rates: [{ category: "", label: "Sales tax", basis_points: 1000 }], prices_include_tax: false, tax_registration: "" });
  const soup = actionHash(
    await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Soup", price_cents: 800, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [], modifier_groups: [] }),
  );
  const listBag = async (title: string, quantity_total: number, ways: { pickup: boolean; delivery: boolean }, endsInSecs = 7200) =>
    actionHash(
      await call(merchant, "catalog")<HcRecord>("create_goodie_bag", {
        catalog_ref: store,
        title,
        original_value_cents: 1800,
        price_cents: 600,
        quantity_total,
        pickup_window_start: Date.now() * 1000,
        pickup_window_end: Date.now() * 1000 + endsInSecs * 1_000_000,
        supports_pickup: ways.pickup,
        supports_delivery: ways.delivery,
        created_at: Date.now() * 1000,
      }),
    );
  const pastries = await listBag("Pastry bag", 1, { pickup: true, delivery: false });
  const bread = await listBag("Bread bag", 2, { pickup: true, delivery: true });
  await sync();
  const geohash = decodeEntry<{ geohash: string }>(published).geohash;
  const nearby = await call(cara, "catalog")<unknown[]>("get_nearby_goodie_bags", { geohash, after: null });
  assert.equal(nearby.length, 2, "found through the store's own listing");
  console.log("[PASS] a store's goodie bags are listed and found nearby");

  // ===== Ordered with the rest of the cart =====
  const pickup = (p: typeof merchant, items: unknown[], order_total: number, extra: Record<string, unknown> = {}) =>
    call(p, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items, order_total, ...extra });
  const one = (item_ref: Uint8Array) => ({ item_ref, quantity: 1, selections: [] });
  await assert.rejects(pickup(cara, [one(soup), one(pastries)], 1400), /the total is now 1540 cents/, "soup and a bag, each at its price, taxed together");
  const order = actionHash(await retryUntilOk(() => pickup(cara, [one(soup), one(pastries)], 1540)));
  await sync();
  console.log("[PASS] a goodie bag is a line of the order, at its own price, taxed with the rest");

  await assert.rejects(pickup(cara, [one(pastries)], 660), /already ordered Pastry bag/, "the customer's app says so first");
  await assert.rejects(
    call(cara, "dispatch")("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [one(pastries)], order_total: 660, dropoff: ST_PETE, max_delivery_fee: 500 }),
    /pickup only/,
    "a pickup-only bag isn't delivered",
  );
  await assert.rejects(pickup(bo, [one(bread)], 600, { promo_code_ref: soup }), /apply to menu items/, "a promo is the menu's");
  console.log("[PASS] the customer's app turns away what validation would");

  // ===== What a modified client can't do =====
  // Cited at the store's current terms -- its tax rate.
  const catalog_version = actionHash(await call(merchant, "catalog")<HcRecord>("get_catalog", store));
  const raw = (p: typeof merchant, lines: unknown[], order_total: number, tax_cents: number, extra: Record<string, unknown> = {}) =>
    call(p, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: p.agentPubKey,
      merchant: merchant.agentPubKey,
      catalog_ref: store,
      catalog_version,
      lines,
      order_total,
      tax_cents,
      age_confirmed: false,
      status: "Placed",
      requested_at: Date.now() * 1000,
      kitchen_note: null,
      promo_code_ref: null,
      loyalty_proof: [],
      ...extra,
    });
  const line = (item_ref: Uint8Array, quantity = 1) => ({ item_ref, priced_version: item_ref, quantity, selections: [] });
  await assert.rejects(raw(cara, [line(pastries)], 660, 60), /each goodie bag once/, "a second of the same bag");
  await assert.rejects(raw(bo, [line(bread, 2)], 1320, 120), /one to a line/, "two of a bag on a line");
  await assert.rejects(raw(bo, [line(bread)], 300, 60), /order_total must be 660/, "a bag at less than its price");
  const otherStore = actionHash(await call(bo, "catalog")<HcRecord>("publish_catalog", { business_name: "Bo's", location: ST_PETE }));
  await sync();
  await assert.rejects(
    raw(cara, [line(bread)], 600, 0, { catalog_ref: otherStore, catalog_version: otherStore, merchant: bo.agentPubKey }),
    /ordered from its own store/,
    "another store's bag",
  );
  console.log("[PASS] validation holds a bag line to its bag: once, one, its price, its store, never the store's own");

  // ===== Sold by the store's acceptance, never past its quantity =====
  const boOrder = actionHash(await retryUntilOk(() => pickup(bo, [one(pastries)], 660)));
  await sync();
  await assert.rejects(
    call(bo, "dispatch")("test_create_link", { link_type: "BagToOrder", base: pastries, target: boOrder }),
    /recorded by the order's store/,
    "a customer can't record a sale",
  );
  await customerPaid(merchant, order, all);
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order }));
  await sync();
  const [standing] = await retryUntil(() => call(cara, "dispatch")<Standing[]>("bag_standings", [pastries]), (s) => s[0].left === 0);
  assert.deepEqual(standing, { left: 0, ordered: true }, "sold to Cara, and she has it");
  await customerPaid(merchant, boOrder, all);
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: boOrder }), /Pastry bag is sold out/, "the second order for the last bag");
  console.log("[PASS] accepting an order sells its bag, and a sold-out bag's order can't be accepted");

  // ===== Its owner orders one like anyone =====
  const own = actionHash(await retryUntilOk(() => pickup(merchant, [one(bread)], 660)));
  await sync();
  await customerPaid(merchant, own, all);
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: own }));
  await sync();
  const [owned] = await retryUntil(() => call(merchant, "dispatch")<Standing[]>("bag_standings", [bread]), (s) => s[0].left === 1);
  assert.deepEqual(owned, { left: 1, ordered: true }, "the owner has one, and one is left for everyone else");
  console.log("[PASS] a store's owner can order their own bag, which takes one off sale");

  // ===== An order that came to nothing doesn't use up the bag =====
  const first = actionHash(await retryUntilOk(() => pickup(bo, [one(bread)], 660)));
  await sync();
  await call(bo, "dispatch")("cancel_pickup_order", first);
  await sync();
  await retryUntilOk(() => pickup(bo, [one(bread)], 660));
  console.log("[PASS] a customer who cancels before the store starts can order the bag again");

  // ===== Only while its window is open =====
  const lastCall = await listBag("Last-call bag", 5, { pickup: true, delivery: true }, 3);
  await sync();
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await assert.rejects(pickup(cara, [one(lastCall)], 660), /no longer available/);
  await assert.rejects(raw(cara, [line(lastCall)], 660, 60), /before its window closes/);
  console.log("[PASS] a bag isn't ordered once its window has closed");
});
