// Proves moving an account to the next version of the network (docs/MIGRATION.md),
// across two real networks: the same DNA under two seeds stands in for the
// old version and the new. On the old network an account seals its private
// details to its key on the new one, records the move and closes its chain
// -- after which Holochain accepts nothing more from it there. No money
// moves: it lives in each person's own processor account. The new app, carrying the old network as its `previous` role, arrives:
// it opens the parcel, brings the account's store over, and counts its
// history -- each checked on the old network.
import assert from "node:assert/strict";
import { dhtSync, runScenario, type CallableCell } from "@holochain-open-dev/tryorama";
import { type Record as HcRecord } from "@holochain/client";
import { HAPP_PATH, shareAgentsOn, ST_PETE, actionHash, decodeEntry, installOn as install, networkSettings as settings, retryUntil, twoNetworkHapp, useTestCoordinators, retryingCaller } from "./helpers.js";

const OLD = "handshake-v1";
const NEW = "handshake-v2";

await runScenario(async (scenario) => {
  const [peerHost, aliceHost, bobHost] = [await scenario.addConductor(), await scenario.addConductor(), await scenario.addConductor()];
  const [peerKey, aliceKey, bobKey] = [await peerHost.adminWs().generateAgentPubKey(), await aliceHost.adminWs().generateAgentPubKey(), await bobHost.adminWs().generateAgentPubKey()];
  const properties = {};
  const next = twoNetworkHapp();

  // The old network: a peer and Alice. The new: the peer, and Bob --
  // Alice's account on the new version, whose app carries the old network
  // too.
  const peerOld = await install(peerHost, peerKey, HAPP_PATH, { handshake: settings(OLD, properties) }, "peer-old");
  const alice = await install(aliceHost, aliceKey, HAPP_PATH, { handshake: settings(OLD, properties) }, "alice-old");
  const peerNew = await install(peerHost, peerKey, HAPP_PATH, { handshake: settings(NEW, properties) }, "peer-new");
  const bob = await install(bobHost, bobKey, next, { handshake: settings(NEW, properties), previous: settings(OLD, properties) }, "bob-next");

  const oldNetwork = peerOld.cells[0].cell_id[0];
  const newNetwork = peerNew.cells[0].cell_id[0];
  const bobHere = bob.namedCells.get("handshake")!;
  const bobPrevious = bob.namedCells.get("previous")!;
  assert.ok(Buffer.from(bobHere.cell_id[0]).equals(Buffer.from(newNetwork)) && Buffer.from(bobPrevious.cell_id[0]).equals(Buffer.from(oldNetwork)), "two networks, as the versions would be");
  await shareAgentsOn([peerHost, aliceHost, bobHost], oldNetwork);
  await shareAgentsOn([peerHost, bobHost], newNetwork);
  const syncOld = () => dhtSync([peerOld, alice, { ...bob, cells: [bobPrevious] }], oldNetwork);
  const on = (cell: CallableCell, zome: string) => retryingCaller(cell, zome);
  for (const [player, cell] of [[alice, alice.cells[0]], [bob, bobHere]] as const) await useTestCoordinators(player, ["account", "catalog"], cell);

  // ===== On the old network: a store =====
  const store = actionHash(await on(alice.cells[0], "catalog")<HcRecord>("publish_catalog", { business_name: "Alice's Bakery", location: ST_PETE }));
  await on(alice.cells[0], "catalog")("add_menu_item", { catalog_ref: store, name: "Sourdough", price_cents: 700, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [], modifier_groups: [], tax_category: "" });

  // ===== Moving out: refused while anything would be stranded =====
  const migrate = { network: newNetwork, successor: bobKey, parcel: JSON.stringify({ name: "Alice" }) };
  await assert.rejects(on(alice.cells[0], "account")("migrate_out", { ...migrate, network: oldNetwork }), /moves to the next one/, "not to the same network");
  await assert.rejects(on(alice.cells[0], "account")("create_raw_migration_for_testing", { network: oldNetwork, successor: bobKey }), /another network/, "nor forged so");
  await on(alice.cells[0], "account")("migrate_out", migrate);
  await assert.rejects(
    on(alice.cells[0], "catalog")("publish_catalog", { business_name: "Alice's Other Bakery", location: ST_PETE }),
    // The author's own conductor refuses any action after the close.
    /chain is closed|after a chain close|moved to the new version/,
    "the old key writes nothing more here",
  );
  console.log("[PASS] an account moves out once, nothing stranded, and its chain closes");

  await syncOld();
  const [request] = await retryUntil(
    () => on(bobPrevious, "account")<{ successor: Uint8Array; network: Uint8Array; close: Uint8Array | null }[]>("migrations_to_me", null),
    (r) => r.length === 1 && !!r[0].close,
  );
  assert.ok(Buffer.from(request.network).equals(Buffer.from(newNetwork)), "the move names the new network");

  // ===== Arriving: the parcel, the store, the history =====
  assert.deepEqual(await on(bobPrevious, "account")<string[]>("open_parcels", aliceKey), [JSON.stringify({ name: "Alice" })], "the new key opens what only the old one could read");
  assert.deepEqual(await on(bobPrevious, "account")<string[]>("open_parcels", peerKey), [], "and only from the account that moved");
  assert.ok(Buffer.from(await on(bobHere, "account")<Uint8Array>("arrive", null)).equals(Buffer.from(aliceKey)), "it arrives as the account it was");
  const was = await on(bobHere, "account")<Uint8Array | null>("arrived_from", bobKey);
  assert.ok(was && Buffer.from(was).equals(Buffer.from(aliceKey)), "checked on the previous network");
  await useTestCoordinators(peerNew, ["account"]);
  console.log(`[DIAG] an app with no previous network, asking it: ${await on(peerNew.cells[0], "account")<string>("previous_raw_for_testing", null)}`);
  assert.equal(await on(peerNew.cells[0], "account")<Uint8Array | null>("arrived_from", bobKey), null, "an app without the previous network can't vouch for it -- told apart from one it couldn't reach");
  await assert.rejects(on(bobHere, "account")("create_raw_arrival_for_testing", { previous_network: newNetwork, previous_account: aliceKey, migration: request.close }), /another network/, "an arrival comes from another network");

  const stores = await on(bobHere, "catalog")<{ original_action: Uint8Array }[]>("previous_stores", null);
  assert.equal(stores.length, 1);
  const imported = await on(bobHere, "catalog")<Uint8Array>("import_store", store);
  assert.deepEqual(await on(bobHere, "catalog")<Uint8Array>("import_store", store), imported, "safe to repeat");
  const [item] = (await on(bobHere, "catalog")<{ items: { record: HcRecord }[] }>("list_menu_items", { catalog_ref: imported, after: null })).items.map((v) => decodeEntry<{ name: string; price_cents: number }>(v.record));
  assert.deepEqual([item.name, item.price_cents], ["Sourdough", 700], "the menu comes over");
  const from = await on(bobHere, "catalog")<Uint8Array | null>("imported_from", imported);
  assert.ok(from && Buffer.from(from).equals(Buffer.from(store)), "and the store's history with it");
  await on(bobHere, "reputation")("get_rating_summary", { Store: imported });
  console.log("[PASS] the new key arrives: details, store and history, each checked on the old network");
});
