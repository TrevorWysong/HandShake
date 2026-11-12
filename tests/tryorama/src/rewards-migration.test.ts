// A store's rewards carried to the next version of the network
// (docs/REWARDS.md, "When a store moves"; docs/MIGRATION.md), across two
// real networks: the same DNA under two seeds stands in for the old version
// and the new.
//
// On the old network a member earns at a store and is given points. Both
// move: the member's old key seals the gifts it was given to its new key
// as it leaves, and the store's owner brings the store over. On the new
// network the member's first order there shows the store their gifts, and
// the store -- its owner's new key, asking the old network through its
// `previous` role -- carries what they held, orders and gifts alike, as a
// grant. The member's card and the store's count agree, to the point. Only
// the store's owner, or the key they moved to, can ask.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { HAPP_PATH, ST_PETE, actionHash, customerPaid, decodeEntry, installOn, networkSettings, onCell, retryUntil, retryUntilOk, retryingCaller, shareAgentsOn, twoNetworkHapp } from "./helpers.js";

const OLD = "handshake-rewards-v1";
const NEW = "handshake-rewards-v2";

interface Card {
  balance: number;
  reserved: number;
  program: { version: ActionHash; program: { rewards: { id: number }[] } } | null;
}

await runScenario(async (scenario) => {
  const hosts = await Promise.all([0, 1, 2, 3, 4].map(() => scenario.addConductor()));
  const [peerHost, aliceHost, caraHost, bobHost, danHost] = hosts;
  const [peerKey, aliceKey, caraKey, bobKey, danKey] = await Promise.all(hosts.map((h) => h.adminWs().generateAgentPubKey()));
  const next = twoNetworkHapp();

  // The old network: a peer, Alice's store, Cara who orders there. The
  // new: the peer, Bob -- Alice's account on the new version -- and Dan,
  // Cara's. Bob's and Dan's apps carry the old network too.
  const peerOld = await installOn(peerHost, peerKey, HAPP_PATH, { handshake: networkSettings(OLD) }, "peer-old");
  const alice = await installOn(aliceHost, aliceKey, HAPP_PATH, { handshake: networkSettings(OLD) }, "alice-old");
  const cara = await installOn(caraHost, caraKey, HAPP_PATH, { handshake: networkSettings(OLD) }, "cara-old");
  const peerNew = await installOn(peerHost, peerKey, HAPP_PATH, { handshake: networkSettings(NEW) }, "peer-new");
  const bobApp = await installOn(bobHost, bobKey, next, { handshake: networkSettings(NEW), previous: networkSettings(OLD) }, "bob-next");
  const danApp = await installOn(danHost, danKey, next, { handshake: networkSettings(NEW), previous: networkSettings(OLD) }, "dan-next");
  const [bob, bobBefore] = [onCell(bobApp, bobApp.namedCells.get("handshake")!), onCell(bobApp, bobApp.namedCells.get("previous")!)];
  const [dan, danBefore] = [onCell(danApp, danApp.namedCells.get("handshake")!), onCell(danApp, danApp.namedCells.get("previous")!)];
  const oldNetwork = peerOld.cells[0].cell_id[0];
  const newNetwork = peerNew.cells[0].cell_id[0];
  await shareAgentsOn([peerHost, aliceHost, caraHost, bobHost, danHost], oldNetwork);
  await shareAgentsOn([peerHost, bobHost, danHost], newNetwork);
  const onOld = [peerOld, alice, cara, bobBefore, danBefore];
  const onNew = [peerNew, bob, dan];
  const syncOld = () => dhtSync(onOld, oldNetwork);
  const syncNew = () => dhtSync(onNew, newNetwork);
  const call = (p: typeof alice, zome: string) => retryingCaller(p.cells[0], zome);
  const now = Date.now() * 1000;

  // ===== On the old network: a member with points, earned and given =====
  await call(alice, "profiles")("create_profile", { display_name: "Alice", roles: ["Merchant"], created_at: now });
  await call(cara, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  const store = actionHash(await call(alice, "catalog")<HcRecord>("publish_catalog", { business_name: "Alice's Bakery", location: ST_PETE }));
  const item = async (name: string, price_cents: number) => actionHash(await call(alice, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name, price_cents, available: true }));
  const soup = await item("Soup", 1000);
  const bread = await item("Bread", 400);
  await call(alice, "rewards")("save_program", {
    catalog_ref: store, active: true, name: "Alice's Rewards", points_name: "points", tagline: "", accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 50, item_bonuses: [{ item_ref: bread, percent: 200 }], happy_hours: [] },
    tiers: [],
    rewards: [
      { id: 1, name: "$2 off", cost: 230, benefit: { FlatOffSubtotal: 200 }, min_tier: 0 },
      { id: 2, name: "$3 off", cost: 305, benefit: { FlatOffSubtotal: 300 }, min_tier: 0 },
      { id: 3, name: "$4 off", cost: 306, benefit: { FlatOffSubtotal: 400 }, min_tier: 0 },
    ],
    birthday_points: 0, expiry_days: null, max_balance: null, time_zone: "UTC",
  });
  await syncOld();
  const order = actionHash(await retryUntilOk(() => call(cara, "dispatch")<HcRecord>("request_pickup_order", { merchant: aliceKey, catalog_ref: store, items: [{ item_ref: soup, quantity: 1 }, { item_ref: bread, quantity: 1 }], order_total: 1400 })));
  await syncOld();
  await customerPaid(alice, order, onOld);
  await retryUntilOk(() => call(alice, "dispatch")("accept_pickup_order", { order_original_action: order }));
  await call(alice, "dispatch")("mark_ready_for_pickup", order);
  await syncOld();
  await retryUntilOk(() => call(cara, "dispatch")("complete_pickup", order), 40);
  await syncOld();
  await retryUntil(() => call(alice, "dispatch")("settle_order", order).then(() => call(cara, "dispatch")<{ refund: number | null }>("get_order_decisions", order)), (d) => d.refund !== null, 60, 1000);
  await syncOld();
  await call(alice, "rewards")("grant_points", { to: caraKey, catalog_ref: store, points: 75, note: "Thanks for coming" });
  await syncOld();
  // $10 of soup, $4 of bread at twice the rate, a welcome, and a gift: 305.
  const held = await retryUntil(() => call(cara, "rewards")<Card>("my_card", store), (c) => c.balance === 305 && c.reserved === 0, 60, 1000);
  assert.equal(held.balance, 305);

  // ===== Both move to the new version =====
  for (const [from, to] of [[cara, danKey], [alice, bobKey]] as const) {
    await retryUntilOk(() => call(from, "account")("migrate_out", { network: newNetwork, successor: to, parcel: "" }), 20);
  }
  await syncOld();
  for (const arriving of [bob, dan]) await retryUntil(() => call(arriving, "account")<Uint8Array>("arrive", null).then(() => true, () => false), (ok) => ok, 60, 1000);
  await call(bob, "profiles")("create_profile", { display_name: "Alice", roles: ["Merchant"], created_at: Date.now() * 1000 });
  await call(dan, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: Date.now() * 1000 });
  const imported = await call(bob, "catalog")<Uint8Array>("import_store", store);
  await syncNew();

  // Only the store's owner, or the key they moved to, may work out its
  // members' points on the old network.
  await assert.rejects(call(peerOld, "rewards")("carried_balance", { catalog_ref: store, member: caraKey, gifts: [] }), /Only the store's owner, or the key they moved it to/, "nobody else asks");
  console.log("[PASS] the old network tells a store's members' points only to its owner, or the key they moved to");

  // ===== The member's first order at the store that came over =====
  const program = await retryUntil(() => call(dan, "rewards")<Card>("my_card", imported), (c) => c.program !== null, 60, 1000);
  assert.equal(program.program!.program.rewards.length, 3, "the program came over with the store");
  const [copiedSoup] = (await call(bob, "catalog")<{ items: { original_action: Uint8Array; record: HcRecord }[] }>("list_menu_items", { catalog_ref: imported, after: null })).items.filter((v) => decodeEntry<{ name: string }>(v.record).name === "Soup").map((v) => v.original_action);
  const first = actionHash(await retryUntilOk(() => call(dan, "dispatch")<HcRecord>("request_pickup_order", { merchant: bobKey, catalog_ref: imported, items: [{ item_ref: copiedSoup, quantity: 1 }], order_total: 1000 })));
  await syncNew();
  await customerPaid(bob, first, onNew);
  await retryUntilOk(() => call(bob, "dispatch")("accept_pickup_order", { order_original_action: first }));
  await syncNew();

  // What Cara held -- orders and the gift alike -- carried over, once.
  const carried = await retryUntil(() => call(dan, "rewards")<Card>("my_card", imported), (c) => c.balance === 305 && c.reserved === 0, 60, 1000);
  assert.equal(carried.balance, 305, "the member's card shows what they held, the gift included");
  const storeAllows = (reward: number) =>
    call(bob, "rewards")("can_redeem", { customer: danKey, catalog_ref: imported, program: carried.program!.version, reward }).then(
      () => true,
      (err) => {
        assert.match(String(err), /points don't cover/);
        return false;
      },
    );
  assert.deepEqual(await Promise.all([1, 2, 3].map(storeAllows)), [true, true, false], "and the store's count agrees, to the point");
  console.log("[PASS] a member's points, earned and given, carry to the store on the next network, both sides agreeing");
});
