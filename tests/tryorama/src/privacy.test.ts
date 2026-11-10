// Proves what the DHT publishes about a customer: no name, and an order's
// area, never its exact drop-off or notes; their name goes only to each
// order's store and driver. Those are sealed -- the drop-off to the
// customer and, once a bid is accepted, to that driver alone; the kitchen
// note to the store -- and so are standing orders.
// Every check that something is hidden looks at the raw published bytes,
// not just at what the honest UI reads.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, commitAndCook, decodeEntry, deliveryStatus, retryUntil, ST_PETE, acceptOrder, testApp, retryingCaller } from "./helpers.js";

/// The entry's serialized bytes, as any peer holding the record sees them.
function publishedBytes(record: HcRecord): Buffer {
  const present = (record.entry as { Present: { entry: Uint8Array } }).Present;
  return Buffer.from(present.entry);
}

interface Details {
  dropoff: { point: { lat: number; lon: number }; notes: string; recipient: string } | null;
  kitchen_note: string | null;
  customer_name: string | null;
}

const PHOTO = "data:image/jpeg;base64,face";

await runScenario(async (scenario) => {
  const [customer, merchant, driver, stranger] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
    testApp,
  ]);
  const all = [customer, merchant, driver, stranger];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  const profiles = new Map<typeof customer, Uint8Array>();
  for (const [p, name, roles] of [[customer, "Cara", ["Requester"]], [merchant, "Mo", ["Merchant"]], [driver, "Dana Reyes", ["Provider"]], [stranger, "Sly", ["Requester"]]] as const) {
    profiles.set(p, actionHash(await call(p, "profiles")<HcRecord>("create_profile", { display_name: name, roles, created_at: now, avatar_data_uri: PHOTO })));
  }
  // A driver's vehicle is kept on their own device.
  const vehicle = { vehicle_description: "Blue Honda Civic", license_plate: "DANA1", photo_data_uri: "" };
  await call(driver, "profiles")("register_provider_credential", { ...vehicle, profile_action: profiles.get(driver), capabilities: ["Food"], verified: false });
  assert.equal(decodeEntry<{ license_plate: string }>((await call(driver, "profiles")<HcRecord | null>("get_my_vehicle", null))!).license_plate, "DANA1", "the driver reads it back");
  assert.equal(await call(stranger, "profiles")<HcRecord | null>("get_my_vehicle", null), null, "and it's only ever their own");
  // A customer publishes no name; a store's is public.
  const profileOf = async (p: typeof customer) => decodeEntry<{ display_name: string; sealed_name: unknown; avatar_data_uri: string }>((await call(p, "profiles")<HcRecord | null>("get_profile_for_agent", p.agentPubKey))!);
  const customerProfile = await profileOf(customer);
  assert.equal(customerProfile.display_name, "", "a customer's profile carries no name");
  assert.ok(customerProfile.sealed_name, "it's sealed to them");
  assert.ok(!Buffer.from(JSON.stringify(customerProfile)).includes("Cara"), "nowhere in the clear");
  assert.equal(await call(customer, "profiles")<string | null>("get_my_name", null), "Cara", "they read it back");
  assert.equal((await profileOf(merchant)).display_name, "Mo", "a store's name is public");
  assert.equal(customerProfile.avatar_data_uri, "", "nor their photo");
  const driverProfile = await profileOf(driver);
  assert.equal(driverProfile.display_name, "Dana", "a driver publishes their first name");
  assert.equal(driverProfile.avatar_data_uri, PHOTO, "and their photo, so a customer knows who's at the door");
  assert.equal(await call(driver, "profiles")<string | null>("get_my_name", null), "Dana Reyes", "the whole of it stays theirs");
  console.log("[PASS] a customer's name and photo aren't published; a store's or driver's first name and photo are");

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Soup", price_cents: 800, available: true }));
  await sync();

  // A home a few hundred meters from the store.
  const home = { lat: 27.7701, lon: -82.6389 };
  const orderRecord = await call(customer, "dispatch")<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: store,
    items: [{ item_ref: item, quantity: 1 }],
    order_total: 800,
    dropoff: home,
    max_delivery_fee: 1_000,
    kitchen_notes: "Allergic to peanuts",
    dropoff_notes: "Gate code 4417",
  });
  const order = actionHash(orderRecord);
  const published = publishedBytes(orderRecord);
  assert.ok(!published.includes("Gate code 4417") && !published.includes("Allergic to peanuts"), "no note is published in the clear");
  const decoded = decodeEntry<Record<string, unknown>>(orderRecord);
  assert.equal(decoded.dropoff, undefined, "no exact drop-off field is published");
  assert.equal(typeof decoded.dropoff_geohash, "string", "only the drop-off's area is");
  console.log("[PASS] a placed order publishes its drop-off area, never the address or the notes");
  await sync();

  const detailsFor = (p: typeof customer) => call(p, "dispatch")<Details>("get_order_private_details", order);
  const mine = await detailsFor(customer);
  assert.deepEqual(mine.dropoff, { point: home, line2: "", notes: "Gate code 4417", recipient: "Cara" }, "the customer reads their own drop-off");
  assert.equal(mine.kitchen_note, "Allergic to peanuts");
  const storeView = await detailsFor(merchant);
  assert.equal(storeView.kitchen_note, "Allergic to peanuts", "the store reads the kitchen note");
  assert.equal(storeView.customer_name, "Cara", "and who the order's for");
  assert.equal(storeView.dropoff, null, "but not the address");
  assert.deepEqual(await detailsFor(stranger), { dropoff: null, kitchen_note: null, allergies: { allergens: [], other: [] }, customer_name: null }, "a stranger reads nothing");
  console.log("[PASS] the customer reads everything, the store only its note, a stranger nothing");

  await acceptOrder(merchant, order, all);
  const vehicleFor = (p: typeof customer) => call(p, "dispatch")<typeof vehicle | null>("get_driver_vehicle", order);
  const bid = actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: 400 }));
  await sync();
  assert.equal((await detailsFor(driver)).dropoff, null, "a bidding driver doesn't get the address");
  assert.equal((await detailsFor(driver)).customer_name, null, "or the customer's name");
  await call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: bid });
  await sync();
  // The driver's app commits as soon as it hears it won, so by now it may
  // have: only a committed driver may hold the address.
  const won = await detailsFor(driver);
  const status = await deliveryStatus(customer, order);
  assert.ok(won.dropoff === null || status !== "BidAccepted", `winning the bid reveals nothing until the driver commits (${status})`);
  // Committing -- collateral set aside -- is what earns the address; the
  // customer's app shares it as soon as it sees that.
  await commitAndCook(driver, merchant, order, all);
  const driverView = await retryUntil(() => detailsFor(driver), (view) => view.dropoff !== null, 60, 1000);
  assert.deepEqual(driverView.dropoff, { point: home, line2: "", notes: "Gate code 4417", recipient: "Cara" }, "the committed driver gets the exact drop-off, and who it's for");
  assert.equal(driverView.customer_name, "Cara");
  assert.equal(driverView.kitchen_note, null, "but not the kitchen note");
  assert.equal((await detailsFor(stranger)).dropoff, null, "a stranger still reads nothing");
  const accepted = publishedBytes(await call(stranger, "dispatch")<HcRecord>("get_order", order));
  assert.ok(!accepted.includes("Gate code 4417"), "the accepted order still publishes nothing in the clear");
  console.log("[PASS] only the driver who has committed learns the address, and only then");

  // The other way: the committed driver's app shares their vehicle with the
  // customer alone, so they know who to look for.
  const shared = await retryUntil(() => vehicleFor(customer), (v) => v !== null, 60, 1000);
  assert.deepEqual(shared, vehicle, "the customer sees the car, its plate and photo");
  assert.equal(await vehicleFor(stranger), null, "a stranger doesn't");
  assert.equal(await vehicleFor(merchant), null, "nor does the store");
  await assert.rejects(call(stranger, "dispatch")("share_vehicle", order), /Only the order's committed driver/, "only the order's driver shares a vehicle for it");
  await assert.rejects(call(driver, "dispatch")("share_vehicle", order), /Only the order's committed driver shares their vehicle, once/, "and only once");
  console.log("[PASS] the committed driver's vehicle reaches its customer, sealed, and nobody else");

  // A standing order keeps its address sealed too.
  const template = await call(customer, "dispatch")<HcRecord>("create_recurring_template", {
    merchant: merchant.agentPubKey,
    catalog_ref: store,
    items: [{ item_ref: item, quantity: 1 }],
    dropoff: home,
    max_delivery_fee: 1_000,
    dropoff_notes: "Gate code 4417",
    recurrence: { Daily: { hour: 9, minute: 0 } },
    time_zone: "America/New_York",
  });
  assert.ok(!publishedBytes(template).includes("Gate code 4417"), "a recurring order's notes aren't published");
  const [view] = await call(customer, "dispatch")<{ details: { dropoff: { lat: number } } | null }[]>("list_my_recurring_templates", null);
  assert.equal(view.details?.dropoff.lat, home.lat, "its owner reads the details back");
  console.log("[PASS] recurring orders store their address sealed");
});
