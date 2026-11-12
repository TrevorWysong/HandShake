// Moving from an earlier release's network to this one (docs/MIGRATION.md,
// "Across versions"): the old network runs the DNA an earlier release
// shipped (fixtures/previous-release, built by scripts/previous-release.sh),
// not this build's. It answers only what that release answered, so this
// version asks what it can rely on (account's `bridge_features`) and does
// without the rest, never failing for it:
//
// - the store comes over, its program with it;
// - a member's first order there is taken, and earns as ever -- nothing is
//   carried from a release that can't work it out, and nothing is retried
//   forever;
// - the store's first-order deal claims cards afresh, with no check of the
//   old network it couldn't answer.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dhtSync, runScenario, type Conductor } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { HAPP_PATH, PREVIOUS_RELEASE_DNA, ST_PETE, actionHash, customerPaid, decodeEntry, installOn, networkSettings, onCell, oneNetworkHapp, retryUntil, retryUntilOk, retryingCaller, shareAgentsOn, twoNetworkHapp } from "./helpers.js";

const OLD = "handshake-cross-v1";
const NEW = "handshake-cross-v2";

assert.ok(existsSync(PREVIOUS_RELEASE_DNA), "an earlier release's DNA: run scripts/previous-release.sh");
const release = JSON.parse(readFileSync(new URL("../fixtures/previous-release/release.json", import.meta.url), "utf8")) as { version: string };

interface Card {
  balance: number;
  reserved: number;
  program: { version: ActionHash } | null;
  history: { kind: string }[];
}

await runScenario(async (scenario) => {
  const hosts: Conductor[] = [];
  for (let i = 0; i < 5; i++) hosts.push(await scenario.addConductor());
  const [peerHost, aliceHost, caraHost, bobHost, danHost] = hosts;
  const keys: Uint8Array[] = [];
  for (const host of hosts) keys.push(await host.adminWs().generateAgentPubKey());
  const [peerKey, aliceKey, caraKey, bobKey, danKey] = keys;
  const earlier = oneNetworkHapp(PREVIOUS_RELEASE_DNA);
  const next = twoNetworkHapp(PREVIOUS_RELEASE_DNA);

  // The old network runs the earlier release; the new, this one -- its
  // apps carrying the earlier release's network as their `previous` role.
  const peerOld = await installOn(peerHost, peerKey, earlier, { handshake: networkSettings(OLD) }, "peer-old");
  const alice = await installOn(aliceHost, aliceKey, earlier, { handshake: networkSettings(OLD) }, "alice-old");
  const cara = await installOn(caraHost, caraKey, earlier, { handshake: networkSettings(OLD) }, "cara-old");
  const peerNew = await installOn(peerHost, peerKey, HAPP_PATH, { handshake: networkSettings(NEW) }, "peer-new");
  const bobApp = await installOn(bobHost, bobKey, next, { handshake: networkSettings(NEW), previous: networkSettings(OLD) }, "bob-next");
  const danApp = await installOn(danHost, danKey, next, { handshake: networkSettings(NEW), previous: networkSettings(OLD) }, "dan-next");
  const [bob, bobBefore] = [onCell(bobApp, bobApp.namedCells.get("handshake")!), onCell(bobApp, bobApp.namedCells.get("previous")!)];
  const [dan, danBefore] = [onCell(danApp, danApp.namedCells.get("handshake")!), onCell(danApp, danApp.namedCells.get("previous")!)];
  const oldNetwork = peerOld.cells[0].cell_id[0];
  const newNetwork = peerNew.cells[0].cell_id[0];
  const onOld = [peerOld, alice, cara, bobBefore, danBefore];
  const onNew = [peerNew, bob, dan];
  const syncOld = async () => {
    await shareAgentsOn(hosts, oldNetwork, 5);
    await dhtSync(onOld, oldNetwork);
  };
  const syncNew = async () => {
    await shareAgentsOn([peerHost, bobHost, danHost], newNetwork, 3);
    await dhtSync(onNew, newNetwork);
  };
  const call = (p: typeof alice, zome: string) => retryingCaller(p.cells[0], zome);
  const now = Date.now() * 1000;

  // ===== On the earlier release's network: a store with a program =====
  await call(alice, "profiles")("create_profile", { display_name: "Alice", roles: ["Merchant"], created_at: now });
  await call(cara, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  const store = actionHash(await call(alice, "catalog")<HcRecord>("publish_catalog", { business_name: "Alice's Bakery", location: ST_PETE }));
  await call(alice, "catalog")("add_menu_item", { catalog_ref: store, name: "Soup", price_cents: 1000, available: true });
  await call(alice, "rewards")("save_program", {
    catalog_ref: store, active: true, name: "Alice's Rewards", points_name: "points", tagline: "", accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 50, item_bonuses: [], happy_hours: [] },
    tiers: [], rewards: [{ id: 1, name: "$1 off", cost: 100, benefit: { FlatOffSubtotal: 100 }, min_tier: 0 }],
    birthday_points: 0, expiry_days: null, max_balance: null, time_zone: "UTC",
  });
  await syncOld();

  // ===== Both move to this version =====
  for (const [from, to] of [[cara, danKey], [alice, bobKey]] as const) await retryUntilOk(() => call(from, "account")("migrate_out", { network: newNetwork, successor: to, parcel: "" }), 20);
  await syncOld();
  for (const arriving of [bob, dan]) await retryUntil(() => call(arriving, "account")<Uint8Array>("arrive", null).then(() => true, () => false), (ok) => ok, 60, 1000);
  await call(bob, "profiles")("create_profile", { display_name: "Alice", roles: ["Merchant"], created_at: Date.now() * 1000 });
  await call(dan, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: Date.now() * 1000 });
  const imported = await call(bob, "catalog")<Uint8Array>("import_store", store);
  await syncNew();
  const card = () => call(dan, "rewards")<Card>("my_card", imported);
  assert.ok((await retryUntil(card, (c) => c.program !== null, 60, 1000)).program, `the store comes over from ${release.version}, its program with it`);
  console.log(`[PASS] a store comes over from ${release.version}'s network, its program with it`);

  // ===== The member's first order, and the store's first-order deal =====
  assert.equal(await call(dan, "rewards")<number>("reveal_my_gifts", imported), 0, "nothing to show from a release that never carried gifts");
  const [soup] = (await call(bob, "catalog")<{ items: { original_action: Uint8Array; record: HcRecord }[] }>("list_menu_items", { catalog_ref: imported, after: null })).items.filter((v) => decodeEntry<{ name: string }>(v.record).name === "Soup").map((v) => v.original_action);
  const first = actionHash(await retryUntilOk(() => call(dan, "dispatch")<HcRecord>("request_pickup_order", { merchant: bobKey, catalog_ref: imported, items: [{ item_ref: soup, quantity: 1 }], order_total: 1000 })));
  await syncNew();
  await customerPaid(bob, first, onNew);
  await retryUntilOk(() => call(bob, "dispatch")("accept_pickup_order", { order_original_action: first }));
  await syncNew();
  const after = await retryUntil(card, (c) => c.reserved === 0, 60, 1000);
  assert.ok(!after.history.some((line) => line.kind === "Carried"), "nothing carried from a release that can't work it out");
  assert.equal(await call(bob, "dispatch")<boolean>("claim_newcomer_card", { store: imported, fingerprint: "fp_card_1", order: first }), true, "the deal claims a card, with no check the old network couldn't answer");
  assert.equal(await call(bob, "dispatch")<boolean>("claim_newcomer_card", { store: imported, fingerprint: "fp_card_1", order: first }), true, "and finds its own claim again");
  console.log(`[PASS] from ${release.version}, orders are taken and deals claimed, doing without what that release can't answer`);
});
