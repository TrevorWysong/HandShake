// Allergens: what a store says, and what a customer tells it. A store's word is
// its own to write and in a fixed shape, an order keeps what was said when it
// was placed, and a customer's allergies reach nobody but the store they chose
// to tell -- not their driver, not the network, not even by the size of a box.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, customerPaid, decodeEntry, limits, retryUntil, retryUntilOk, retryingCaller, ST_PETE, testApp, appWithProperties, useTestCoordinators } from "./helpers.js";

type Details = { kitchen_note: string | null; allergies: { allergens: string[]; other: string[] } };
const SEALED = { allergens: ["Peanuts", "Milk"], other: ["Kiwi"] };

await runScenario(async (scenario) => {
  const [customer, store, stranger] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, store, stranger];
  await scenario.shareAllAgents();
  const sync = (from = store) => dhtSync(all, from.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(store, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const shop = actionHash(await call(store, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const dish = { catalog_ref: shop, name: "Satay", price_cents: 1000, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [], modifier_groups: [] };
  const facts = { contains: ["Peanuts"], may_contain: ["Sesame"], other: ["Kiwi"], note: "Fried in shared oil.", can_omit: [] };

  // ===== A store's word on an item, in a fixed shape =====
  const unsaid = actionHash(await call(store, "catalog")<HcRecord>("add_menu_item", dish));
  const satayRecord = await call(store, "catalog")<HcRecord>("add_menu_item", { ...dish, allergens: facts });
  const satay = actionHash(satayRecord);
  assert.deepEqual(decodeEntry<{ allergens: unknown }>(satayRecord).allergens, facts);
  const { items } = await call(store, "catalog")<{ items: { original_action: Uint8Array; record: HcRecord }[] }>("list_menu_items", { catalog_ref: shop, after: null });
  const unsaidItem = items.find((view) => Buffer.from(view.original_action).equals(Buffer.from(unsaid)));
  assert.equal(decodeEntry<{ allergens: unknown }>(unsaidItem!.record).allergens, null, "an item that hasn't said reads as nothing said, not none");
  const refused = (allergens: unknown) => call(store, "catalog")("add_menu_item", { ...dish, allergens });
  await assert.rejects(refused({ ...facts, contains: ["Peanuts", "Peanuts"] }), /listed once/);
  await assert.rejects(refused({ ...facts, may_contain: ["Peanuts"] }), /not both/, "an allergen's either in it or may be");
  await assert.rejects(refused({ ...facts, can_omit: ["Soy"] }), /left out/, "only what's in it can be left out");
  await assert.rejects(refused({ ...facts, other: ["   "] }), /has a name/);
  await assert.rejects(refused({ ...facts, other: Array(9).fill("Kiwi") }), /at most 8/);
  await assert.rejects(refused({ ...facts, note: "x".repeat(1001) }), /note/);
  await assert.rejects(refused({ ...facts, contains: ["Nothing to worry about"] }), /allergen's code/, "a code is a code");
  await assert.rejects(call(stranger, "catalog")("add_menu_item", { ...dish, allergens: { ...facts, contains: [] } }), /./, "nobody writes on another store's menu");
  console.log("[PASS] a store's word on an item is its own, and in a fixed shape");

  // ===== What a choice adds =====
  const group = { catalog_ref: shop, name: "Extras", min_selections: 0, max_selections: 1, max_per_option: 1, free_selections: 0 };
  const option = { id: 1, name: "Add cheese", price_cents: 100, available: true, nested_group: null, contains: ["Milk"], other_allergens: [] };
  const extras = await call(store, "catalog")<HcRecord>("create_modifier_group", { ...group, options: [option] });
  assert.deepEqual(decodeEntry<{ options: { contains: string[] }[] }>(extras).options[0].contains, ["Milk"]);
  await assert.rejects(call(store, "catalog")("create_modifier_group", { ...group, options: [{ ...option, contains: ["Milk", "Milk"] }] }), /listed once/);
  await assert.rejects(call(store, "catalog")("create_modifier_group", { ...group, options: [{ ...option, other_allergens: [""] }] }), /has a name/);
  console.log("[PASS] a choice says what it adds");

  // ===== A kitchen's policy =====
  const setPolicy = (who: typeof customer, requests: string, extra = {}) => call(who, "catalog")<HcRecord>("set_allergy_policy", { original_action: shop, allergy_policy: { kitchen: ["Peanuts"], other: [], requests, note: "", ...extra } });
  await assert.rejects(setPolicy(stranger, "Welcome"), /./, "only its store sets it");
  await assert.rejects(setPolicy(store, "Welcome", { kitchen: ["Soy", "Soy"] }), /listed once/);
  await assert.rejects(setPolicy(store, "Whatever"), /./);
  await setPolicy(store, "NotAccepted");
  await sync();
  const placeOrder = (items: Uint8Array, allergies: unknown, kitchen_notes = "") => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: store.agentPubKey, catalog_ref: shop, items: [{ item_ref: items, quantity: 1 }], order_total: 1000, kitchen_notes, allergies });
  await assert.rejects(placeOrder(satay, SEALED), /can't work to allergy requests/, "told before anything's placed that it can't work to them");
  await setPolicy(store, "Welcome");
  await sync();
  await assert.rejects(placeOrder(satay, { allergens: ["Soy", "Soy"], other: [] }), /listed once/);
  console.log("[PASS] a store's policy is its own, and one that can't work to requests says so before an order's placed");

  // ===== Told to the store alone, in a box that gives nothing away =====
  const withoutAny = await placeOrder(satay, { allergens: [], other: [] });
  const withThem = await placeOrder(satay, SEALED, "No sauce please");
  const noteLength = (record: HcRecord) => decodeEntry<{ kitchen_note: { encrypted_data: Uint8Array } }>(record).kitchen_note.encrypted_data.length;
  assert.equal(noteLength(withThem), noteLength(withoutAny), "a box the same size with allergies in it as without");
  assert.ok(decodeEntry<{ kitchen_note: unknown }>(withoutAny).kitchen_note, "and every order has one");
  const told = actionHash(withThem);
  await sync(customer);
  const detailsFor = (who: typeof customer) => call(who, "dispatch")<Details>("get_order_private_details", told);
  assert.deepEqual((await detailsFor(customer)).allergies, SEALED);
  const storeReads = await retryUntilOk(() => detailsFor(store));
  assert.deepEqual(storeReads.allergies, SEALED, "the store reads them");
  assert.equal(storeReads.kitchen_note, "No sauce please");
  const strangerReads = await detailsFor(stranger);
  assert.deepEqual(strangerReads.allergies, { allergens: [], other: [] }, "nobody else does");
  assert.equal(strangerReads.kitchen_note, null);
  assert.ok(!JSON.stringify(decodeEntry(withThem)).includes("Peanuts"), "and nothing on the order names them");
  console.log("[PASS] a customer's allergies reach the store they told and nobody else, in a box the same size as anyone's");

  // ===== A person reads them: no conductor accepts for them =====
  await call(store, "catalog")("set_auto_accept_orders", { original_action: shop, auto_accept_orders: true });
  await sync();
  const plain = actionHash(await placeOrder(satay, { allergens: [], other: [] }));
  await sync(customer);
  await customerPaid(store, plain, all);
  await customerPaid(store, told, all);
  const statusOf = async (order: Uint8Array) => decodeEntry<{ status: string }>(await call(customer, "dispatch")<HcRecord>("get_pickup_order", order)).status;
  await retryUntil(() => statusOf(plain), (status) => status === "MerchantConfirmed", 60, 1000);
  assert.equal(await statusOf(told), "Placed", "the store's auto-accept took the plain order and left this one for a person");
  console.log("[PASS] a store's auto-accept leaves an order with allergies on it for a person to read");

  await call(store, "catalog")("set_auto_accept_orders", { original_action: shop, auto_accept_orders: false });
  await assert.rejects(call(stranger, "dispatch")("decline_pickup_order", { order_original_action: told, reason: "CantMakeAsAsked" }), /./, "only its store answers");
  await retryUntilOk(() => call(store, "dispatch")("decline_pickup_order", { order_original_action: told, reason: "CantMakeAsAsked" }));
  await retryUntil(() => statusOf(told), (status) => status === "Cancelled");
  console.log("[PASS] a store that can't meet them can say so");
  const declined = decodeEntry<{ cancellation: unknown }>(await call(customer, "dispatch")<HcRecord>("get_pickup_order", told));
  assert.deepEqual(declined.cancellation, { ByStore: "CantMakeAsAsked" }, "and its public reason says nothing of allergies");

  // The largest note a customer can write, with every allergen and all their
  // own words, still seals and opens.
  const everything = { allergens: ["Milk", "Eggs", "Fish", "Crustaceans", "Molluscs", "TreeNuts", "Peanuts", "Wheat", "Gluten", "Soy", "Sesame", "Celery", "Mustard", "Sulphites", "Lupin"], other: Array.from({ length: 8 }, (_, i) => `${"🌰".repeat(25)}${i}`) };
  const fullest = await placeOrder(satay, everything, "🥜".repeat(550));
  await sync(customer);
  assert.deepEqual((await retryUntilOk(() => call(store, "dispatch")<Details>("get_order_private_details", actionHash(fullest)))).allergies, everything);
  await assert.rejects(placeOrder(satay, { allergens: [], other: Array(8).fill("🌰".repeat(40)) }), /more allergies than an order can carry/, "and more than that is refused, saying why");
  await assert.rejects(placeOrder(satay, everything, "🥜".repeat(limits.MAX_NOTE_CHARS)), /Shorten it/, "as is too long a note beside them");
  console.log("[PASS] the largest request seals and opens");

  // ===== An order keeps what was said when it was placed =====
  const before = await placeOrder(satay, { allergens: [], other: [] });
  await call(store, "catalog")("update_menu_item", { original_action: satay, item: { ...dish, allergens: { ...facts, contains: [] } } });
  await sync();
  const [line] = await retryUntilOk(() => call(customer, "dispatch")<{ allergens: { contains: string[] } }[]>("get_order_lines", actionHash(before)));
  assert.deepEqual(line.allergens.contains, ["Peanuts"], "the order's version still says what it said");
  console.log("[PASS] an order keeps what its store said when it was placed");

  // ===== A customer's own list =====
  const allergiesOf = (who: typeof customer) => call(who, "profiles")<{ allergens: string[]; other: string[] }>("my_allergies", null);
  assert.deepEqual(await allergiesOf(customer), { allergens: [], other: [] }, "none until they say");
  await useTestCoordinators(customer, ["profiles"]);
  const sealedLength = () => call(customer, "profiles")<number | null>("my_sealed_allergies_length_for_testing", null);
  const emptyLength = await sealedLength();
  assert.ok(emptyLength, "every account holds a sealed list from the start, so holding one says nothing");
  await assert.rejects(call(customer, "profiles")("save_my_allergies", { allergens: ["Soy", "Soy"], other: [] }), /listed once/);
  await assert.rejects(call(customer, "profiles")("save_my_allergies", { allergens: [], other: Array(9).fill("Kiwi") }), /at most 8/);
  await call(customer, "profiles")("save_my_allergies", SEALED);
  assert.deepEqual(await allergiesOf(customer), SEALED);
  assert.equal(await sealedLength(), emptyLength, "and its size says nothing of what's on it");
  await call(customer, "profiles")("save_my_allergies", { allergens: ["Soy"], other: [] });
  assert.deepEqual(await allergiesOf(customer), { allergens: ["Soy"], other: [] }, "the latest they said");
  await sync(customer);
  assert.deepEqual(await allergiesOf(stranger), { allergens: [], other: [] }, "another account reads only its own");
  console.log("[PASS] a customer's own allergies are sealed to them, and theirs alone to change");
});

// An unattended store, by the clock: a short window, and auto-accept on.
await runScenario(async (scenario) => {
  const app = appWithProperties({ store_response_secs: 120 });
  const [customer, store] = await scenario.addPlayersWithApps([app, app]);
  const all = [customer, store];
  await scenario.shareAllAgents();
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(store, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const shop = actionHash(await call(store, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const dish = actionHash(await call(store, "catalog")<HcRecord>("add_menu_item", { catalog_ref: shop, name: "Satay", price_cents: 1000, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [], modifier_groups: [] }));
  await call(store, "catalog")("set_auto_accept_orders", { original_action: shop, auto_accept_orders: true });
  await dhtSync(all, store.cells[0].cell_id[0]);
  const place = () => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: store.agentPubKey, catalog_ref: shop, items: [{ item_ref: dish, quantity: 1 }], order_total: 1000, allergies: SEALED });
  const order = actionHash(await place());
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await customerPaid(store, order, all);
  const state = async () => decodeEntry<{ status: string; cancellation: unknown }>(await call(customer, "dispatch")<HcRecord>("get_pickup_order", order));
  const finished = await retryUntil(state, ({ status }) => status === "Cancelled", 120, 2000);
  assert.deepEqual(finished.cancellation, { ByStore: "CantMakeAsAsked" }, "declined before it could lapse as unanswered");
  const record = await call(customer, "reputation")<{ cancelled_by_them_count: number }>("get_reputation_summary", { Store: shop });
  assert.equal(record.cancelled_by_them_count, 0, "and it costs an unattended store nothing on its record");
  console.log("[PASS] an order nobody's there to read is declined in time, leaving the store's record alone");

  // And a store that works from its tickets can let auto-accept take them.
  await call(store, "catalog")("set_allergy_policy", { original_action: shop, allergy_policy: { kitchen: [], other: [], requests: "Welcome", note: "", auto_accept_requests: true } });
  await dhtSync(all, store.cells[0].cell_id[0]);
  const taken = actionHash(await place());
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await customerPaid(store, taken, all);
  await retryUntil(async () => decodeEntry<{ status: string }>(await call(customer, "dispatch")<HcRecord>("get_pickup_order", taken)).status, (status) => status === "MerchantConfirmed", 60, 1000);
  console.log("[PASS] a store that works from its tickets can let auto-accept take them");
});
