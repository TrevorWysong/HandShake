// Rewards under sustained contention (docs/REWARDS.md): two stores, two
// members at each, every member holding exactly the points one reward
// costs. Round after round, each member names that reward on several
// orders at once -- two, five, ten, three -- as a modified app or several of
// their devices could, and each store answers all of its members' orders at
// the same moment. Every round, for every member: exactly one is accepted,
// the rest are refused for their points, and the member's card and the
// store's check agree to the point. rewards-concurrency covers the single
// race and the stale-branch cases.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, appWithProperties, customerPaid, decodeEntry, retryUntil, retryUntilOk, retryingCaller, useTestCoordinators } from "./helpers.js";

/// Orders each member names the reward on, at once, in each round.
const ROUNDS = [2, 5, 10, 3];
const COST = 100;
const PRICE = 500;

await runScenario(async (scenario) => {
  const app = appWithProperties({ max_pending_orders: 100 });
  const players = await scenario.addPlayersWithApps([app, app, app, app]);
  const [storeA, storeB, ada, bo] = players;
  await scenario.shareAllAgents();
  for (const p of players) await useTestCoordinators(p, ["rewards", "dispatch"]);
  const sync = () => dhtSync(players, ada.cells[0].cell_id[0]);
  const call = (p: typeof ada, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  for (const [i, p] of players.entries()) await call(p, "profiles")("create_profile", { display_name: `P${i}`, roles: [i < 2 ? "Merchant" : "Requester"], created_at: now });
  const stores: { owner: typeof ada; catalog: Uint8Array; stew: Uint8Array }[] = [];
  for (const owner of [storeA, storeB]) {
    const catalog = actionHash(await call(owner, "catalog")<HcRecord>("publish_catalog", { business_name: "Store", location: ST_PETE }));
    const stew = actionHash(await call(owner, "catalog")<HcRecord>("add_menu_item", { catalog_ref: catalog, name: "Stew", price_cents: PRICE, available: true }));
    await call(owner, "rewards")("save_program", {
      catalog_ref: catalog, active: true, name: "Rewards", points_name: "points", tagline: "", accent: "Ember",
      earn: { points_per_dollar: 1, min_order_cents: 0, max_per_order: null, welcome_bonus: 0, item_bonuses: [], happy_hours: [] },
      tiers: [], rewards: [{ id: 1, name: "$1 off", cost: COST, benefit: { FlatOffSubtotal: 100 }, min_tier: 0 }],
      birthday_points: 0, expiry_days: null, max_balance: null, time_zone: "UTC",
    });
    stores.push({ owner, catalog, stew });
  }
  await sync();

  // Each member a member at each store: an order of theirs it accepted.
  for (const { owner, catalog, stew } of stores) {
    for (const member of [ada, bo]) {
      const order = actionHash(await retryUntilOk(() => call(member, "dispatch")<HcRecord>("request_pickup_order", { merchant: owner.agentPubKey, catalog_ref: catalog, items: [{ item_ref: stew, quantity: 1 }], order_total: PRICE })));
      await sync();
      await customerPaid(owner, order, players);
      await retryUntilOk(() => call(owner, "dispatch")("accept_pickup_order", { order_original_action: order }));
    }
  }
  await sync();

  const card = (member: typeof ada, catalog: Uint8Array) => call(member, "rewards")<{ balance: number; reserved: number; program: { version: ActionHash } | null }>("my_card", catalog);
  const storeAllows = (owner: typeof ada, member: typeof ada, catalog: Uint8Array, program: ActionHash) =>
    call(owner, "rewards")("can_redeem", { customer: member.agentPubKey, catalog_ref: catalog, program, reward: 1 }).then(
      () => true,
      (err) => {
        assert.match(String(err), /points don't cover/);
        return false;
      },
    );
  const statusOf = async (owner: typeof ada, order: Uint8Array) => decodeEntry<{ status: string }>(await owner.cells[0].callZome<HcRecord>({ zome_name: "dispatch", fn_name: "get_pickup_order", payload: order })).status;

  for (const [round, many] of ROUNDS.entries()) {
    // Every member given exactly one reward's worth, at every store.
    for (const { owner, catalog } of stores) {
      for (const member of [ada, bo]) await call(owner, "rewards")("grant_points", { to: member.agentPubKey, catalog_ref: catalog, points: COST, note: `round ${round}` });
    }
    await sync();
    const placed: { owner: typeof ada; member: typeof ada; catalog: Uint8Array; program: ActionHash; order: Uint8Array }[] = [];
    for (const { owner, catalog, stew } of stores) {
      const version = actionHash(await call(ada, "catalog")<HcRecord>("get_catalog", catalog));
      for (const member of [ada, bo]) {
        const held = await retryUntil(() => card(member, catalog), (c) => c.balance === COST && c.reserved === 0, 30, 1000);
        assert.equal(held.balance, COST, `round ${round}: each member holds one reward's worth`);
        const program = held.program!.version;
        for (let n = 0; n < many; n++) {
          const record = await call(member, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
            requester: member.agentPubKey, merchant: owner.agentPubKey, catalog_ref: catalog, catalog_version: version,
            lines: [{ item_ref: stew, priced_version: stew, quantity: 1, selections: [] }],
            order_total: PRICE - 100, status: "Placed", requested_at: Date.now() * 1000, kitchen_note: null, promo_code_ref: null,
            loyalty_proof: [], rewards: { program, reward: 1 }, cancellation: null, ready_by: null, customer_payment: null, sealed_customer_name: null,
          });
          placed.push({ owner, member, catalog, program, order: actionHash(record) });
        }
      }
    }
    await sync();
    for (const { owner, order } of placed) await customerPaid(owner, order, players);
    // Each store answers all of its members' orders at the same moment.
    const accept = (owner: typeof ada, order: Uint8Array) => owner.cells[0].callZome({ zome_name: "dispatch", fn_name: "accept_pickup_order", payload: { order_original_action: order } });
    await Promise.allSettled(placed.map(({ owner, order }) => accept(owner, order)));
    await sync();
    // Whatever was turned away -- its points, or its store's chain moving
    // under it -- is tried again, then declined as the store's app would.
    for (const { owner, order } of placed) {
      if ((await statusOf(owner, order)) !== "Placed") continue;
      await accept(owner, order).catch((err) => assert.match(String(err), /points don't cover/, `round ${round}: refused for its points`));
      if ((await statusOf(owner, order)) === "Placed") await retryUntilOk(() => owner.cells[0].callZome({ zome_name: "dispatch", fn_name: "decline_pickup_order", payload: { order_original_action: order, reason: "RewardUnavailable" } }));
    }
    await sync();
    for (const { owner, catalog } of stores) {
      for (const member of [ada, bo]) {
        const theirs = placed.filter((p) => p.owner === owner && p.member === member);
        const accepted = (await Promise.all(theirs.map((p) => statusOf(owner, p.order)))).filter((s) => s === "MerchantConfirmed").length;
        assert.equal(accepted, 1, `round ${round} (${many} at once): exactly one of a member's orders is accepted`);
        const after = await retryUntil(() => card(member, catalog), (c) => c.balance === 0 && c.reserved === 0, 30, 1000);
        assert.deepEqual([after.balance, after.reserved], [0, 0], `round ${round}: the member's card spends the reward once`);
        assert.ok(!(await storeAllows(owner, member, catalog, theirs[0].program)), `round ${round}: and the store's count agrees`);
      }
    }
    console.log(`[PASS] round ${round + 1}: ${many} orders at once for each of 2 members at each of 2 stores, one reward's worth each -- one accepted per member, both sides agree`);
  }
});
