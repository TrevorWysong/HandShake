// A store's rewards program (docs/REWARDS.md): only its owner runs it, and
// nothing about a member's points is published -- the store works them out
// from its own records, and its member's app the same from theirs. Points
// come only from what was paid (once the refund period is over) or from the
// store's own grants, sealed to the member; and they're spent only on a
// reward the store accepts, after checking the member's points cover it.
// An order the store never accepted spends nothing. Forgeries are written
// raw (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, bytesEqual, decodeEntry, retryUntil, retryUntilOk, retryingCaller, testApp, useTestCoordinators, customerPaid } from "./helpers.js";

interface Card {
  balance: number;
  reserved: number;
  tier: number;
  program: { version: ActionHash } | null;
  history: { kind: string; points: number; note: string | null }[];
}
interface Order {
  rewards: { program: ActionHash; reward: number | null } | null;
  order_total: number;
}

await runScenario(async (scenario) => {
  const [customer, merchant, stranger] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, merchant, stranger];
  await scenario.shareAllAgents();
  for (const p of all) await useTestCoordinators(p, ["rewards", "dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const rewards = (p: typeof customer) => call(p, "rewards");
  const card = (p: typeof customer = customer) => rewards(p)<Card>("my_card", store);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = async (name: string, price_cents: number) => actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name, price_cents, available: true }));
  const soup = await item("Soup", 1000);
  const bread = await item("Bread", 400);
  const elsewhere = actionHash(await call(stranger, "catalog")<HcRecord>("publish_catalog", { business_name: "Elsewhere", location: ST_PETE }));
  const theirs = actionHash(await call(stranger, "catalog")<HcRecord>("add_menu_item", { catalog_ref: elsewhere, name: "Pie", price_cents: 500, available: true }));
  await sync();

  // ===== The program: its owner's alone, within its limits =====
  const program = {
    catalog_ref: store,
    active: true,
    name: "Mo's Rewards",
    points_name: "points",
    tagline: "Soup gets you bread",
    accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 50, item_bonuses: [{ item_ref: bread, percent: 200 }], happy_hours: [] },
    tiers: [{ name: "Gold", threshold: 1000, percent: 150, perk: "" }],
    rewards: [
      { id: 1, name: "Free bread", cost: 100, benefit: { FreeItem: { item_ref: bread, quantity: 1 } }, min_tier: 0 },
      { id: 2, name: "$5 off", cost: 50, benefit: { FlatOffSubtotal: 500 }, min_tier: 1 },
      { id: 3, name: "$1 off", cost: 5000, benefit: { FlatOffSubtotal: 100 }, min_tier: 0 },
      { id: 4, name: "$2 off", cost: 200, benefit: { FlatOffSubtotal: 200 }, min_tier: 0 },
    ],
    birthday_points: 0,
    expiry_days: null,
    max_balance: null,
    time_zone: "UTC",
  };
  await assert.rejects(rewards(stranger)("save_program", program), /Only the store's owner/);
  await assert.rejects(rewards(stranger)("create_raw_program_for_testing", program), /only a store's owner/, "the network refuses it too");
  await assert.rejects(rewards(merchant)("save_program", { ...program, earn: { ...program.earn, points_per_dollar: 500 } }), /points a dollar/);
  await assert.rejects(rewards(merchant)("save_program", { ...program, rewards: [{ ...program.rewards[0], benefit: { FreeItem: { item_ref: theirs, quantity: 1 } } }] }), /own store's items/, "only its own menu");
  await rewards(merchant)("save_program", program);
  await assert.rejects(rewards(merchant)("create_raw_program_for_testing", program), /one program/, "one program a store; it changes by updates");
  await sync();
  console.log("[PASS] a store's program is its owner's alone, once, within its limits and its own menu");

  // ===== An order joins the program and earns once it's settled =====
  const pickup = (items: { item_ref: Uint8Array; quantity: number }[], order_total: number, reward: number | null = null) =>
    call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items, order_total, reward });
  const accept = async (order: ActionHash) => {
    await sync();
    await customerPaid(merchant, order, all);
    await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order }));
  };
  const fulfil = async (order: ActionHash) => {
    await accept(order);
    await call(merchant, "dispatch")("mark_ready_for_pickup", order);
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
    await sync();
    // The store settles once the customer's report window passes.
    await retryUntil(() => call(merchant, "dispatch")("settle_order", order).then(() => call(customer, "dispatch")<{ refund: number | null }>("get_order_decisions", order)), (d) => d.refund !== null, 60, 1000);
    await sync();
  };
  const first = await retryUntilOk(() => pickup([{ item_ref: soup, quantity: 1 }, { item_ref: bread, quantity: 1 }], 1400));
  const firstRef = actionHash(first);
  assert.ok(decodeEntry<Order>(first).rewards, "it joins the store's program");
  await fulfil(firstRef);
  // $10 of soup at 10 a dollar, $4 of bread at twice that, and the welcome
  // with their first settled order.
  const earned = await retryUntil(() => card(), (c) => c.balance > 0, 30, 1000);
  assert.equal(earned.balance, 100 + 80 + 50);
  assert.deepEqual(earned.history.map((l) => [l.kind, l.points]), [["Earned", 230]], "what it earned, as the rules played it");
  console.log("[PASS] a settled order earns its food at the program's rate, bonus items faster, with a welcome");

  // ===== The store works out the same, from its own records =====
  const redeemable = (customerKey: Uint8Array, reward: number) => rewards(merchant)("can_redeem", { customer: customerKey, catalog_ref: store, program: earned.program!.version, reward });
  await redeemable(customer.agentPubKey, 1);
  await redeemable(customer.agentPubKey, 4);
  await assert.rejects(redeemable(customer.agentPubKey, 3), /points don't cover/);
  await assert.rejects(redeemable(customer.agentPubKey, 2), /tier doesn't reach/);
  await assert.rejects(redeemable(stranger.agentPubKey, 1), /points don't cover/, "a stranger to the store has nothing");
  await assert.rejects(rewards(stranger)("can_redeem", { customer: customer.agentPubKey, catalog_ref: store, program: earned.program!.version, reward: 1 }), /owner/, "and only the store asks");
  console.log("[PASS] the store reaches the same points from its own records -- nothing about them is published");

  // ===== Spending: only what the store accepts, and nothing on an order it never did =====
  await assert.rejects(pickup([{ item_ref: soup, quantity: 1 }], 1000, 1), /doesn't apply/, "a free bread needs bread in the cart");
  await assert.rejects(pickup([{ item_ref: soup, quantity: 2 }], 1500, 2), /higher tier/, "Gold's reward needs Gold");
  await assert.rejects(pickup([{ item_ref: soup, quantity: 1 }, { item_ref: bread, quantity: 1 }], 1300, 3), /enough points/, "the app checks its own card first");
  const declined = actionHash(await pickup([{ item_ref: soup, quantity: 1 }, { item_ref: bread, quantity: 1 }], 1000, 1));
  const held = await card();
  assert.deepEqual([held.balance, held.reserved], [130, 100], "held for the order while the store answers");
  await sync();
  await retryUntilOk(() => call(merchant, "dispatch")("decline_pickup_order", { order_original_action: declined, reason: "TooBusy" }));
  await sync();
  assert.deepEqual(await retryUntil(() => card().then((c) => [c.balance, c.reserved]), ([, r]) => r === 0, 30, 1000), [230, 0], "declined before it was accepted: nothing spent");

  const spent = await pickup([{ item_ref: soup, quantity: 1 }, { item_ref: bread, quantity: 1 }], 1000, 1);
  const spentRef = actionHash(spent);
  assert.equal(decodeEntry<Order>(spent).order_total, 1000, "the bread is free");
  assert.equal(decodeEntry<Order>(spent).rewards!.reward, 1, "the order names its reward");
  await accept(spentRef);
  await sync();
  assert.equal((await retryUntil(() => card(), (c) => c.reserved === 0)).balance, 130, "spent once the store took it");
  await assert.rejects(redeemable(customer.agentPubKey, 4), /points don't cover/, "and the store counts it too: 130 left");
  console.log("[PASS] a reward is spent only when the store accepts its order -- one it declined spends nothing");

  // A modified app can name a reward its points don't cover; the store won't take it.
  const version = actionHash(await call(customer, "catalog")<HcRecord>("get_catalog", store));
  const programVersion = decodeEntry<Order>(spent).rewards!.program;
  const raw = (rewardsField: unknown, total: number, who = customer) =>
    call(who, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: who.agentPubKey, merchant: merchant.agentPubKey, catalog_ref: store, catalog_version: version,
      lines: [{ item_ref: soup, priced_version: soup, quantity: 1, selections: [] }, { item_ref: bread, priced_version: bread, quantity: 1, selections: [] }],
      order_total: total, status: "Placed", requested_at: Date.now() * 1000, kitchen_note: null, promo_code_ref: null,
      loyalty_proof: [], rewards: rewardsField, cancellation: null, ready_by: null, customer_payment: null, sealed_customer_name: null,
    });
  await assert.rejects(raw({ program: programVersion, reward: 9 }, 1400), /no such reward/, "a reward the program doesn't have");
  await assert.rejects(raw({ program: programVersion, reward: null }, 1000), /promo code's requirement|lines at their priced versions/, "no discount without a reward");
  const greedy = actionHash(await raw({ program: programVersion, reward: 3 }, 1300));
  await sync();
  await customerPaid(merchant, greedy, all);
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: greedy }), /points don't cover/, "the store won't accept a reward the points don't cover");
  await call(customer, "dispatch")("cancel_pickup_order", greedy);
  await sync();
  console.log("[PASS] an order naming a reward its customer can't afford isn't accepted");

  // ===== The store's grants: sealed, to its own customers, and only its count =====
  await rewards(merchant)<ActionHash>("grant_points", { to: customer.agentPubKey, catalog_ref: store, points: 75, note: "Sorry about the wait" });
  await assert.rejects(rewards(stranger)("grant_points", { to: customer.agentPubKey, catalog_ref: store, points: 1000, note: "" }), /store's owner/);
  // A stranger sealing a grant "from" the store, citing the customer's real order: refused.
  await assert.rejects(rewards(stranger)("create_raw_points_grant_for_testing", { to: customer.agentPubKey, catalog_ref: store, order: firstRef, points: 1000, note: "From Mo's, honest" }), /only a store's owner/);
  await sync();
  const gifted = await retryUntil(() => card(), (c) => c.balance === 205, 30, 1000);
  assert.equal(gifted.history[0].note, "Sorry about the wait");
  await redeemable(customer.agentPubKey, 4).catch(() => assert.fail("the store counts its own grant: 205"));
  console.log("[PASS] a store's grant counts on both sides; nobody else can write one in its name");

  // ===== A store can't send points to someone who's never ordered there =====
  await rewards(stranger)("save_program", { ...program, catalog_ref: elsewhere, name: "Free Points!", rewards: [], earn: { ...program.earn, item_bonuses: [] } });
  await assert.rejects(rewards(stranger)("grant_points", { to: customer.agentPubKey, catalog_ref: elsewhere, points: 500, note: "Claim your prize" }), /only to customers who've ordered here/);
  await assert.rejects(rewards(stranger)("create_raw_points_grant_for_testing", { to: customer.agentPubKey, catalog_ref: elsewhere, order: firstRef, points: 500, note: "Claim your prize" }), /only to someone who's ordered there/, "nor by citing their order at another store");
  assert.equal((await rewards(customer)<unknown[]>("my_cards", null)).length, 1, "the wallet holds only stores they've ordered from");
  console.log("[PASS] a store can give points only to its own customers -- nobody can fill a stranger's inbox");

  // ===== The store holds orders to its current program =====
  // (Another customer's orders: the network limits how fast one places them.)
  await rewards(merchant)("save_program", { ...program, earn: { ...program.earn, points_per_dollar: 1 } });
  await sync();
  const underOld = actionHash(await raw({ program: programVersion, reward: null }, 1400, stranger));
  await sync();
  await customerPaid(merchant, underOld, all);
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: underOld }), /rewards program's earlier terms/, "an order citing a replaced version isn't accepted");
  const fresh = decodeEntry<Order>(await retryUntilOk(() => call(stranger, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: soup, quantity: 1 }], order_total: 1000 })));
  assert.ok(fresh.rewards && !bytesEqual(fresh.rewards.program, programVersion), "a new order cites the current version");
  console.log("[PASS] the store accepts only orders under its current program");

  // ===== Birthdays are private =====
  await rewards(customer)("set_birth_month", 3);
  assert.equal(await rewards(customer)("my_birth_month", null), 3);
  assert.equal(await rewards(stranger)("my_birth_month", null), null);
  await assert.rejects(rewards(customer)("set_birth_month", 4), /already set/);
  console.log("[PASS] a birth month stays on its owner's device, told to stores sealed");
});
