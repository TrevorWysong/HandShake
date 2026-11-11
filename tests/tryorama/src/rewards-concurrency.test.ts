// Rewards when things happen at once (docs/REWARDS.md). A member's points
// are never stored: the store works them out from its own records as it
// accepts an order that spends some, and the member's app the same from
// theirs. So what has to hold is that two of those at once can't both
// spend the same points, and that an order's history branching can't spend
// them or give them back on one side only:
//
// - two orders that each spend the only reward the points cover, accepted
//   by the store at the same moment: one stands, the other is refused;
// - an order cancelled before the store started, which the store then
//   accepts on the version from before the cancel, spends nothing;
// - an order whose start its customer saw, then cancelled on the version
//   from before, spends its reward -- the same rule as the food;
// - the store recording the same order twice at once counts it once;
// - after the store changes its program, both sides play the history
//   afresh and still agree.
//
// Both sides are read each time: the member's card, and the store's own
// check. Branches are written raw (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, appWithProperties, bytesEqual, customerPaid, decodeEntry, retryUntil, retryUntilOk, retryingCaller, useTestCoordinators } from "./helpers.js";

interface Card {
  balance: number;
  reserved: number;
  program: { version: ActionHash } | null;
}

await runScenario(async (scenario) => {
  // One customer places seven orders here in a few minutes.
  const app = appWithProperties({ max_pending_orders: 20 });
  const [customer, merchant] = await scenario.addPlayersWithApps([app, app]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();
  for (const p of all) await useTestCoordinators(p, ["rewards", "dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const dispatch = <T = unknown>(p: typeof customer, fn_name: string, payload: unknown) => p.cells[0].callZome<T>({ zome_name: "dispatch", fn_name, payload });
  const card = () => call(customer, "rewards")<Card>("my_card", store);
  /// The member's spendable points, once nothing's held for an order.
  const settledBalance = (expected: number) => retryUntil(() => card(), (c) => c.reserved === 0 && c.balance === expected, 60, 1000).then((c) => c.balance);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = async (name: string, price_cents: number) => actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name, price_cents, available: true }));
  const soup = await item("Soup", 1000);
  const bread = await item("Bread", 400);
  await sync();
  const programSettings = {
    catalog_ref: store,
    active: true,
    name: "Mo's Rewards",
    points_name: "points",
    tagline: "",
    accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 50, item_bonuses: [{ item_ref: bread, percent: 200 }], happy_hours: [] },
    tiers: [],
    rewards: [
      { id: 1, name: "Free bread", cost: 100, benefit: { FreeItem: { item_ref: bread, quantity: 1 } }, min_tier: 0 },
      { id: 2, name: "$2 off", cost: 200, benefit: { FlatOffSubtotal: 200 }, min_tier: 0 },
      { id: 3, name: "$3 off", cost: 300, benefit: { FlatOffSubtotal: 300 }, min_tier: 0 },
    ],
    birthday_points: 0,
    expiry_days: null,
    max_balance: null,
    time_zone: "UTC",
  };
  await call(merchant, "rewards")("save_program", programSettings);
  await sync();

  const soupAndBread = [{ item_ref: soup, quantity: 1 }, { item_ref: bread, quantity: 1 }];
  const pickup = (order_total: number, reward: number | null = null) =>
    retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: soupAndBread, order_total, reward }));
  const accept = (order: Uint8Array) => dispatch(merchant, "accept_pickup_order", { order_original_action: order });
  /// The store's own check that the member's points cover `reward`.
  const storeAllows = (reward: number, program: ActionHash) =>
    call(merchant, "rewards")("can_redeem", { customer: customer.agentPubKey, catalog_ref: store, program, reward }).then(
      () => true,
      (err) => {
        assert.match(String(err), /points don't cover/);
        return false;
      },
    );

  // ===== Points to spend: a settled order, its refund period over =====
  const first = actionHash(await pickup(1400));
  await sync();
  await customerPaid(merchant, first, all);
  await retryUntilOk(() => accept(first));
  await call(merchant, "dispatch")("mark_ready_for_pickup", first);
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", first), 40);
  await sync();
  await retryUntil(() => call(merchant, "dispatch")("settle_order", first).then(() => call(customer, "dispatch")<{ refund: number | null }>("get_order_decisions", first)), (d) => d.refund !== null, 60, 1000);
  await sync();
  // $10 of soup at 10 a dollar, $4 of bread at twice that, and the welcome.
  assert.equal(await settledBalance(230), 230);
  const program = (await card()).program!.version;
  assert.ok(await storeAllows(2, program), "the store counts the same 230");

  // ===== Cancelled before the store started: the reward comes back, on both sides =====
  const early = await pickup(1000, 1);
  const earlyRef = actionHash(early);
  await sync();
  await customerPaid(merchant, earlyRef, all);
  const food = decodeEntry<Record<string, unknown>>(await retryUntil(() => dispatch<HcRecord>(merchant, "get_pickup_order", earlyRef), () => true)).customer_payment;
  await call(customer, "dispatch")("cancel_pickup_order", earlyRef);
  await sync();
  // A modified store app accepts on the version from before the cancel.
  await dispatch(merchant, "update_raw_pickup_order_for_testing", { version: earlyRef, order: { ...decodeEntry<Record<string, unknown>>(early), status: "MerchantConfirmed", ready_by: (Date.now() + 15 * 60_000) * 1000, customer_payment: food } }).catch(() => {});
  await sync();
  assert.equal(await settledBalance(230), 230, "the member's card spends nothing");
  assert.ok(await storeAllows(2, program), "nor does the store's count");
  console.log("[PASS] an order cancelled before the store started spends no points, whatever the store writes on an older version");

  // ===== Cancelled after the customer saw the store start: the reward is spent =====
  const late = await pickup(1000, 1);
  const lateRef = actionHash(late);
  await sync();
  await customerPaid(merchant, lateRef, all);
  await retryUntilOk(() => accept(lateRef));
  await sync();
  // The customer's app confirms what it saw, as it does by itself.
  await retryUntil(async () => (await call(customer, "dispatch")("confirm_what_i_saw", lateRef).catch(() => null), call(customer, "dispatch")<boolean>("i_confirmed", lateRef)), (seen) => seen, 30, 1000);
  // A modified customer app cancels on the version from before the store started.
  await retryUntilOk(() => dispatch(customer, "update_raw_pickup_order_for_testing", { version: lateRef, order: { ...decodeEntry<Record<string, unknown>>(late), status: "Cancelled", cancellation: "ByCustomer" } }));
  await sync();
  assert.equal(await settledBalance(130), 130, "the member's card counts the reward spent");
  assert.ok(!(await storeAllows(2, program)), "and so does the store's: 130 doesn't cover $2 off");
  console.log("[PASS] an order cancelled on an older version after its customer saw the store start spends its reward, on both sides");

  // ===== Two orders spending the same points, accepted at once =====
  // 130 points cover one free bread, not two. A modified app (or two of the
  // customer's devices) names the reward on both; the store's app answers
  // both at the same moment.
  const version = actionHash(await call(customer, "catalog")<HcRecord>("get_catalog", store));
  const raw = () =>
    call(customer, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey, merchant: merchant.agentPubKey, catalog_ref: store, catalog_version: version,
      lines: [{ item_ref: soup, priced_version: soup, quantity: 1, selections: [] }, { item_ref: bread, priced_version: bread, quantity: 1, selections: [] }],
      order_total: 1000, status: "Placed", requested_at: Date.now() * 1000, kitchen_note: null, promo_code_ref: null,
      loyalty_proof: [], rewards: { program, reward: 1 }, cancellation: null, ready_by: null, customer_payment: null, sealed_customer_name: null,
    });
  const both = [actionHash(await raw()), actionHash(await raw())];
  await sync();
  for (const order of both) await customerPaid(merchant, order, all);
  const answers = await Promise.allSettled(both.map(accept));
  console.log(`    at once: ${answers.map((a) => (a.status === "fulfilled" ? "accepted" : `refused (${String(a.reason).slice(0, 80)})`)).join("; ")}`);
  await sync();
  // Whatever was refused at once -- by its points, or because the store's
  // chain moved under it -- is tried again, as the store's app would.
  const statusOf = async (order: Uint8Array) => decodeEntry<{ status: string }>(await dispatch<HcRecord>(merchant, "get_pickup_order", order)).status;
  for (const order of both) {
    if ((await statusOf(order)) === "Placed") await accept(order).catch((err) => assert.match(String(err), /points don't cover/, "refused for its points, once the other's spent them"));
  }
  await sync();
  const statuses = await Promise.all(both.map(statusOf));
  assert.equal(statuses.filter((s) => s === "MerchantConfirmed").length, 1, `exactly one is accepted (${statuses.join(", ")})`);
  // Until the store answers the other, its points stay held on the card;
  // the store declines it, as its app does an order whose reward it refused.
  const refused = both[statuses.indexOf("Placed")];
  assert.ok(refused, "the other is still waiting on the store");
  assert.deepEqual(await card().then((c) => [c.balance, c.reserved]), [0, 100], "held for it meanwhile: 30 left, less the 100 it would spend");
  await retryUntilOk(() => dispatch(merchant, "decline_pickup_order", { order_original_action: refused, reason: "RewardUnavailable" }));
  await sync();
  assert.equal(await settledBalance(30), 30, "the member's card spends the reward once");
  assert.ok(!(await storeAllows(1, program)), "and the store counts 30 left, short of another");
  console.log("[PASS] two orders spending the same points, accepted at the same moment: one stands, the other is refused");

  // ===== The same order recorded twice at once: counted once =====
  // An order of soup and bread earns 180: 30 + 180 is 210, enough for $2
  // off and not $3. Counted twice, it'd be 390.
  const repeated = actionHash(await pickup(1400));
  await sync();
  await customerPaid(merchant, repeated, all);
  const acceptance = actionHash(await retryUntilOk(() => accept(repeated) as Promise<HcRecord>));
  const record = () => call(merchant, "rewards")("record_member_order", { order: repeated, accepted: acceptance });
  await Promise.allSettled([record(), record()]);
  await record();
  await call(merchant, "dispatch")("mark_ready_for_pickup", repeated);
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", repeated), 40);
  await sync();
  await retryUntil(() => call(merchant, "dispatch")("settle_order", repeated).then(() => call(customer, "dispatch")<{ refund: number | null }>("get_order_decisions", repeated)), (d) => d.refund !== null, 60, 1000);
  await sync();
  assert.equal(await settledBalance(210), 210, "the member's card earns it once");
  assert.ok(await retryUntil(() => storeAllows(2, program), (ok) => ok, 30, 1000), "the store counts it too");
  assert.ok(!(await storeAllows(3, program)), "once: not the 390 it'd be counted twice");
  console.log("[PASS] the store recording the same order twice at once counts it once, and agrees with the member's card");

  // ===== The store changes its program: both sides play it all afresh, and agree =====
  await call(merchant, "rewards")("save_program", { ...programSettings, tagline: "Now with more bread" });
  await sync();
  const changed = await retryUntil(() => card(), (c) => c.program !== null && !bytesEqual(c.program.version, program), 30, 1000);
  assert.ok(!bytesEqual(changed.program!.version, program), "the card plays under the new version");
  assert.equal(await settledBalance(210), 210, "the member's card, played afresh, comes to the same");
  assert.ok(await storeAllows(2, changed.program!.version) && !(await storeAllows(3, changed.program!.version)), "and so does the store's");
  console.log("[PASS] after the store changes its program, both sides play the history afresh and still agree");
});
