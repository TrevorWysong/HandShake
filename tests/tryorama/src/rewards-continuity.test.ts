// A store's rewards outlast the store's device (docs/REWARDS.md, "When a
// store moves"). Everything a member's points rest on is public -- the
// store's links to its acceptances, its settlements, its grants -- so the
// store's private running totals are only a cache:
//
// - a store whose device is restored from the network (the same key) works
//   out every member's points again, gifts included, and agrees with each
//   member's card to the point;
// - a store recovered onto its owner's new key, and moved there, carries
//   its program (naming the copies of its items) and its members' points:
//   their orders' history plays on at the new store, and the gifts the old
//   key gave -- sealed to it -- count once the member shows them to the new
//   key, proven against each grant's public commitment, on both sides
//   alike; and a card that took its first-order deal under the old key
//   still can't take it again.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, customerPaid, decodeEntry, phraseKey, phraseMessage, restoreInPlace, retryUntil, retryUntilOk, retryingCaller, setupPlayersWithProperties } from "./helpers.js";

interface Card {
  catalog_ref: Uint8Array;
  balance: number;
  reserved: number;
  program: { version: ActionHash; program: { rewards: { id: number; benefit: { FreeItem?: { item_ref: Uint8Array } } }[] } } | null;
}
const same = (a: Uint8Array | null | undefined, b: Uint8Array) => !!a && Buffer.from(a).equals(Buffer.from(b));

await runScenario(async (scenario) => {
  // A store, its member, a neighbour -- a restore needs two others holding
  // the store's chain -- and the key the store's owner recovers onto.
  const players = await setupPlayersWithProperties(scenario, 4, () => ({}));
  let [owner] = players;
  const [, member, neighbour, successor] = players;
  // A node restored from the network never holds exactly the ops the rest
  // do, which is what `dhtSync` asks (device-move.test.ts): once the
  // store's device is restored, the others sync, and it reads what it
  // needs as it comes.
  let restored = false;
  const everyone = () => (restored ? [member, neighbour, successor] : [owner, member, neighbour, successor]);
  const dna = member.cells[0].cell_id[0];
  const sync = () => dhtSync(everyone(), dna);
  const call = (p: typeof member, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(owner, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(member, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  const store = actionHash(await call(owner, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = async (name: string, price_cents: number) => actionHash(await call(owner, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name, price_cents, available: true }));
  const soup = await item("Soup", 1000);
  const bread = await item("Bread", 400);
  await call(owner, "rewards")("save_program", {
    catalog_ref: store, active: true, name: "Mo's Rewards", points_name: "points", tagline: "", accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 50, item_bonuses: [{ item_ref: bread, percent: 200 }], happy_hours: [] },
    tiers: [],
    rewards: [
      { id: 1, name: "Free bread", cost: 100, benefit: { FreeItem: { item_ref: bread, quantity: 1 } }, min_tier: 0 },
      { id: 2, name: "$2 off", cost: 230, benefit: { FlatOffSubtotal: 200 }, min_tier: 0 },
      { id: 3, name: "$3 off", cost: 305, benefit: { FlatOffSubtotal: 300 }, min_tier: 0 },
      { id: 4, name: "$4 off", cost: 306, benefit: { FlatOffSubtotal: 400 }, min_tier: 0 },
    ],
    birthday_points: 0, expiry_days: null, max_balance: null, time_zone: "UTC",
  });
  await sync();

  const card = (catalog: Uint8Array) => call(member, "rewards")<Card>("my_card", catalog);
  const settledCard = (catalog: Uint8Array, balance: number) => retryUntil(() => card(catalog), (c) => c.reserved === 0 && c.balance === balance, 60, 1000);
  /// Whether the store's owner `by` finds the member's points cover `reward`.
  const storeAllows = (by: typeof member, catalog: Uint8Array, program: ActionHash, reward: number) =>
    call(by, "rewards")("can_redeem", { customer: member.agentPubKey, catalog_ref: catalog, program, reward }).then(
      () => true,
      (err) => {
        assert.match(String(err), /points don't cover/);
        return false;
      },
    );

  // ===== A member with points: an order earned, and a gift =====
  const order = actionHash(await retryUntilOk(() => call(member, "dispatch")<HcRecord>("request_pickup_order", { merchant: owner.agentPubKey, catalog_ref: store, items: [{ item_ref: soup, quantity: 1 }, { item_ref: bread, quantity: 1 }], order_total: 1400 })));
  await sync();
  await customerPaid(owner, order, everyone());
  await retryUntilOk(() => call(owner, "dispatch")("accept_pickup_order", { order_original_action: order }));
  await call(owner, "dispatch")("mark_ready_for_pickup", order);
  await sync();
  await retryUntilOk(() => call(member, "dispatch")("complete_pickup", order), 40);
  await sync();
  await retryUntil(() => call(owner, "dispatch")("settle_order", order).then(() => call(member, "dispatch")<{ refund: number | null }>("get_order_decisions", order)), (d) => d.refund !== null, 60, 1000);
  await sync();
  // $10 of soup and $4 of bread at twice the rate, with a welcome: 230.
  assert.equal((await settledCard(store, 230)).balance, 230);
  await call(owner, "rewards")("grant_points", { to: member.agentPubKey, catalog_ref: store, points: 75, note: "Thanks for coming" });
  await sync();
  const program = (await settledCard(store, 305)).program!.version;
  const agree = async (by: typeof member, catalog: Uint8Array, version: ActionHash, balance: number, why: string) => {
    assert.equal((await settledCard(catalog, balance)).balance, balance, `${why}: the member's card`);
    const expected = [100, 230, 305, 306].map((cost) => cost <= balance);
    const covered = await retryUntil(() => Promise.all([1, 2, 3, 4].map((reward) => storeAllows(by, catalog, version, reward))), (c) => c.every((ok, i) => ok === expected[i]), 30, 1000);
    assert.deepEqual(covered, expected, `${why}: the store's count agrees, to the point`);
  };
  await agree(owner, store, program, 305, "before");

  // ===== The store's device restored from the network =====
  await retryUntil(() => call(owner, "account")<{ ready: boolean }>("ready_to_move", null), (r) => r.ready, 60, 1000);
  owner = await restoreInPlace(owner);
  restored = true;
  await scenario.shareAllAgents();
  const after = await retryUntil(() => call(owner, "rewards")<{ members: number; orders: number }>("program_stats", store), (s) => s.members === 1 && s.orders === 1, 60, 1000);
  assert.deepEqual([after.members, after.orders], [1, 1], "its members and their orders, read again from the network");
  await agree(owner, store, program, 305, "restored");
  console.log("[PASS] a store whose device is restored works out its members' points again, gifts and all, and agrees with their cards");

  // A card took the store's first-order deal on that order.
  assert.equal(await call(owner, "dispatch")<boolean>("claim_newcomer_card", { store, fingerprint: "fp_card_1", order }), true);
  await sync();

  // ===== The store recovered onto its owner's new key, and moved there =====
  const phrase = phraseKey();
  const plan = await call(owner, "account")<{ plan: Uint8Array }>("set_recovery_plan", { phrase_key: phrase.key, guardians: [], threshold: 0 });
  await sync();
  const head = await retryUntil(() => call(successor, "account")<Uint8Array | null>("latest_action_of", owner.agentPubKey), (h) => !!h);
  await call(successor, "account")("take_over", { predecessor: owner.agentPubKey, authority: { Phrase: { plan: plan.plan, head, signature: phrase.sign(phraseMessage(owner.agentPubKey, successor.agentPubKey, head!)) } } });
  await sync();
  const moved = await call(successor, "catalog")<Uint8Array>("move_store", store);
  await sync();
  const carried = await retryUntil(() => card(moved), (c) => c.program !== null, 60, 1000);
  const [copiedBread] = (await call(successor, "catalog")<{ items: { original_action: Uint8Array; record: HcRecord }[] }>("list_menu_items", { catalog_ref: moved, after: null })).items.filter((v) => decodeEntry<{ name: string }>(v.record).name === "Bread").map((v) => v.original_action);
  assert.ok(same(carried.program!.program.rewards[0].benefit.FreeItem?.item_ref, copiedBread), "the program moves with the store, naming the copied bread");
  // The orders' 230 carry on, and the old key's 75: the member's card shows
  // it to the new key as it first plays the store, and both count it.
  await settledCard(moved, 305);
  await sync();
  await agree(successor, moved, carried.program!.version, 305, "moved");
  // The card that took the old store's first-order deal is still known.
  const later = actionHash(await retryUntilOk(() => call(member, "dispatch")<HcRecord>("request_pickup_order", { merchant: successor.agentPubKey, catalog_ref: moved, items: [{ item_ref: copiedBread, quantity: 1 }], order_total: 400 })));
  await sync();
  const claim = (fingerprint: string) => call(successor, "dispatch")<boolean>("claim_newcomer_card", { store: moved, fingerprint, order: later });
  assert.equal(await claim("fp_card_1"), false, "a card that took the deal before the move can't take it again after");
  assert.equal(await claim("fp_card_2"), true, "another card can");
  const wallet = await call(member, "rewards")<Card[]>("my_cards", null);
  assert.ok(wallet.length === 1 && same(wallet[0].catalog_ref, moved), "the member's wallet shows the store once, as it is now");
  console.log("[PASS] a store moved to its owner's new key carries its program, its members' points -- the old key's gifts included -- and the cards that took its first-order deal");
});
