// Proves Browse finds every store near someone however many there are, a
// page at a time, the way the network lists them:
//
// - every store in the cells around someone is found from the listings
//   alone -- well past one read's worth of stores -- each once, with where
//   it is, so an app ranks them nearest first before reading any;
// - stores are read in bounded batches, never more at once;
// - past the cells around someone, the wider area finds the stores farther
//   out, the near ones among them again;
// - a store taken out of the listings leaves both, and comes back to both.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, bytesEqual, decodeEntry, installManyAgents, retryingCaller, retryUntil, ST_PETE } from "./helpers.js";

const OWNERS = 6;
const STORES_EACH = 10;
/// Within a few hundred metres of the customer: in the cells around them.
const NEAR = 55;
/// About 3 km north: past those cells, inside the wider area.
const FAR_LAT = 0.027;
const BATCH = 50;
const AREA_PRECISION = 5;

interface NearbyListing {
  catalog: Uint8Array;
  geohash: string;
}

await runScenario(async (scenario) => {
  const conductor = await scenario.addConductor();
  const [customer, ...owners] = await installManyAgents(conductor, OWNERS + 1, "browse");
  const all = [customer, ...owners];
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const catalog = (p: typeof customer) => retryingCaller(p.cells[0], "catalog");

  const now = Date.now() * 1000;
  await retryingCaller(customer.cells[0], "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  const stores: Uint8Array[] = [];
  for (const [o, owner] of owners.entries()) {
    await retryingCaller(owner.cells[0], "profiles")("create_profile", { display_name: `Owner ${o}`, roles: ["Merchant"], created_at: now });
    for (let s = 0; s < STORES_EACH; s++) {
      const n = o * STORES_EACH + s;
      const location = n < NEAR ? { lat: ST_PETE.lat + (n % 8) * 0.0002, lon: ST_PETE.lon + Math.floor(n / 8) * 0.0002 } : { lat: ST_PETE.lat + FAR_LAT, lon: ST_PETE.lon + (n - NEAR) * 0.0005 };
      stores.push(actionHash(await catalog(owner)<HcRecord>("publish_catalog", { business_name: `Store ${n}`, location })));
    }
  }
  await sync();
  const here = decodeEntry<{ geohash: string }>(await catalog(customer)<HcRecord>("get_catalog", stores[0])).geohash;
  const listed = (geohash: string, count: number) =>
    retryUntil(() => catalog(customer)<NearbyListing[]>("get_nearby_listings", geohash), (l) => l.length >= count, 60, 1000);
  const has = (listings: NearbyListing[], store: Uint8Array) => listings.filter((l) => bytesEqual(l.catalog, store)).length;

  // ===== Every store around here, from the listings alone =====
  const near = await listed(here, NEAR);
  assert.equal(near.length, NEAR, "every store in the cells around here, past one read's worth, and none from farther out");
  for (const store of stores.slice(0, NEAR)) assert.equal(has(near, store), 1, "each store once");
  assert.ok(near.every((l) => l.geohash.length === 8), "each says where it is, to about 20 metres");
  console.log(`[PASS] all ${NEAR} stores around someone are found from their listings alone, each once, saying where it is`);

  // ===== Read in bounded batches =====
  await assert.rejects(catalog(customer)("get_listed_stores", near.slice(0, BATCH + 1).map((l) => l.catalog).concat(stores[NEAR])), /fewer stores at once/);
  const batch = await catalog(customer)<{ original_action: Uint8Array }[]>("get_listed_stores", near.slice(0, BATCH).map((l) => l.catalog));
  assert.equal(batch.length, BATCH, "a full batch reads every store in it");
  const rest = await catalog(customer)<{ original_action: Uint8Array }[]>("get_listed_stores", near.slice(BATCH).map((l) => l.catalog));
  assert.equal(rest.length, NEAR - BATCH, "and the next, the rest");
  console.log("[PASS] stores are read a bounded batch at a time");

  // ===== Farther out, from the wider area =====
  const wider = await listed(here.slice(0, AREA_PRECISION), stores.length);
  assert.equal(wider.length, stores.length, "the wider area finds every store, the near ones among them");
  for (const store of stores) assert.equal(has(wider, store), 1);
  console.log("[PASS] past the cells around someone, the wider area finds the stores farther out");

  // ===== Out of the listings, and back =====
  const closing = stores[0];
  await catalog(owners[0])("close_listing", closing);
  await sync();
  const gone = async (geohash: string) => retryUntil(() => catalog(customer)<NearbyListing[]>("get_nearby_listings", geohash), (l) => has(l, closing) === 0, 60, 1000);
  assert.equal(has(await gone(here), closing), 0);
  assert.equal(has(await gone(here.slice(0, AREA_PRECISION)), closing), 0, "closed in both");
  await catalog(owners[0])("reopen_listing", closing);
  await sync();
  assert.equal(has(await listed(here, NEAR), closing), 1);
  assert.equal(has(await listed(here.slice(0, AREA_PRECISION), stores.length), closing), 1, "reopened in both");
  console.log("[PASS] a store taken out of the listings leaves the near and wider areas both, and comes back to both");
});
