// Points are earned only once an order's refund period is over -- after the
// store settles it and the network's window to appeal that settlement has
// passed -- so they always match what the customer finally paid. Until
// then they show as pending, and the store doesn't count them. An appealed
// order earns once its arbiter rules, less what they awarded
// (docs/REWARDS.md).
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, retryUntil, retryUntilOk, retryingCaller, setupPlayersWithProperties, useTestCoordinators, customerPaid } from "./helpers.js";

/// Seconds after a settlement its customer may appeal it, here.
const WINDOW_SECS = 25;

interface OrderPoints {
  points: number;
  status: string | { RefundPeriod: { until: number } };
}

await runScenario(async (scenario) => {
  const [customer, merchant, arbiter] = await setupPlayersWithProperties(scenario, 3, (keys) => ({ arbiters: [keys[2]], appeal_window_secs: WINDOW_SECS }));
  const all = [customer, merchant, arbiter];
  for (const p of all) await useTestCoordinators(p, ["rewards"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const rewards = call(customer, "rewards");

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 2000, available: true }));
  const program = {
    catalog_ref: store, active: true, name: "Mo's Rewards", points_name: "points", tagline: "", accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 0, item_bonuses: [], happy_hours: [] },
    tiers: [], rewards: [{ id: 1, name: "$1 off", cost: 200, benefit: { FlatOffSubtotal: 100 }, min_tier: 0 }], birthday_points: 0, expiry_days: null, max_balance: null, time_zone: "UTC",
  };
  await call(merchant, "rewards")("save_program", program);
  await sync();

  /// A pickup of stew the customer collects and the store settles; the
  /// store's acceptance of it, and when it settled.
  const settled = async () => {
    const order = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 2000 })));
    await sync();
    await customerPaid(merchant, order, all);
    const accepted = actionHash(await retryUntilOk(() => call(merchant, "dispatch")<HcRecord>("accept_pickup_order", { order_original_action: order })));
    await call(merchant, "dispatch")("mark_ready_for_pickup", order);
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
    await sync();
    await retryUntil(() => call(merchant, "dispatch")("settle_order", order).then(() => call(customer, "dispatch")<{ refund: number | null }>("get_order_decisions", order)), (d) => d.refund !== null, 60, 1000);
    await sync();
    const settlement = await retryUntil(() => call(customer, "dispatch")<ActionHash | null>("order_settlement", order), (s) => !!s);
    return { order, accepted, settlement: settlement! };
  };
  const balance = () => rewards<{ balance: number; pending_points: number; program: { version: ActionHash } }>("my_card", store);
  /// Whether the store, from its own records, counts the customer's 200 points (reward 1's cost).
  const storeCounts = async () => {
    const version = (await call(merchant, "rewards")<{ version: ActionHash }>("program_of", store)).version;
    return call(merchant, "rewards")("can_redeem", { customer: customer.agentPubKey, catalog_ref: store, program: version, reward: 1 }).then(() => true, () => false);
  };

  // ===== Settled: pending through the refund period, then earned =====
  const first = await settled();
  const pending = await rewards<OrderPoints>("order_points", first.order);
  assert.ok(typeof pending.status === "object" && "RefundPeriod" in pending.status, "pending until the refund period ends");
  assert.equal(pending.points, 200);
  assert.deepEqual([(await balance()).balance, (await balance()).pending_points], [0, 200], "shown as pending on the card");
  assert.equal(await storeCounts(), false, "and the store doesn't count them yet");
  console.log("[PASS] a settled order's points are pending through its refund period, on both sides");

  await retryUntil(() => balance(), (b) => b.balance === 200, 60, 1000);
  assert.equal((await rewards<OrderPoints>("order_points", first.order)).status, "Earned");
  assert.equal(await storeCounts(), true, "the store counts them too");
  console.log("[PASS] once the refund period is over, they're earned");

  // ===== Appealed: earned on the ruling, less the award =====
  const second = await settled();
  const appeal = await call(customer, "dispatch")<ActionHash>("file_appeal", { order: second.order, amount: 1500, note: "Cold", photo_data_uri: "" });
  await sync();
  // Past the window: still pending, on the arbiter.
  await new Promise((resolve) => setTimeout(resolve, WINDOW_SECS * 1000));
  assert.equal((await rewards<OrderPoints>("order_points", second.order)).status, "InReview");
  assert.equal((await balance()).balance, 200, "not before the ruling");
  await call(arbiter, "dispatch")("rule_on_appeal", { appeal, award: 1000, reasons: "Half of it" });
  await sync();
  await retryUntil(() => balance(), (b) => b.balance === 300, 60, 1000);
  console.log("[PASS] an appealed order earns once its arbiter rules, on what the customer finally paid: $10");
});
