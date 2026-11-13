// Proves a store's findings on a customer's report (docs/REPUTATION.md,
// phases 2 and 3) are held to what's fair:
//
// - that a report wasn't made in good faith: only by the order's store, only
//   on a report about items it declined -- its decline alone never marks
//   anyone; counted only from an established store, and not once an appeal
//   the customer won overturns it;
// - that the driver was at fault: only on a report on the delivery the store
//   refunded; the driver reads what the customer wrote;
// - each answered once, publicly, by the one it's about and nobody else.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, collectFromStore, commitAndCook, customerPaid, handOff, payeeAgent, retryUntil, retryUntilOk, retryingCaller, setupPlayersWithProperties, ST_PETE, useTestCoordinators } from "./helpers.js";

const REPORT_WINDOW_SECS = 20;

interface IssueView {
  issue: Uint8Array;
  accepted: boolean | null;
  answer: Uint8Array | null;
  evidence: { note: string } | null;
}
interface Summary {
  bad_faith_stores: number;
  faulted_count: number;
}
interface FindingView {
  event: Uint8Array;
  counts: boolean;
  reply: string | null;
  finding: Record<string, string>;
}

await runScenario(async (scenario) => {
  // A store's findings count once it's completed two orders, from anyone;
  // and one store's are enough to show -- so one store proves each rule.
  const [customer, merchant, driver, arbiter] = await setupPlayersWithProperties(scenario, 4, (keys) => ({
    arbiters: [keys[3]],
    report_window_secs: REPORT_WINDOW_SECS,
    min_flagger_orders: 2,
    min_flagger_customers: 1,
    min_flagging_stores: 1,
  }));
  const all = [customer, merchant, driver, arbiter];
  for (const p of all) await useTestCoordinators(p, ["dispatch", "reputation"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 1000, available: true }));
  await sync();

  const pickup = async () => {
    const order = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000 })));
    await sync();
    await customerPaid(merchant, order, all);
    await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order }));
    await call(merchant, "dispatch")("mark_ready_for_pickup", order);
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
    await sync();
    return order;
  };
  const viewOf = async (by: typeof customer, order: Uint8Array) => retryUntil(() => call(by, "dispatch")<IssueView[]>("get_issues_for_order", order), (v) => v.length === 1 && v[0].answer !== null).then((v) => v[0]);
  const summary = (target: object) => call(merchant, "reputation")<Summary>("get_reputation_summary", target);
  const findings = (target: object) => call(customer, "reputation")<FindingView[]>("get_findings", target);
  const raw = (by: typeof customer, input: object) => call(by, "reputation")("record_event", input);

  // ===== Bad faith: only on a declined report about items, by its store =====
  const first = await pickup();
  const report = actionHash(await call(customer, "dispatch")<HcRecord>("report_issue", { order: first, lines: [{ line: 0, quantity: 1, kind: "Missing" }], note: "", photo_data_uri: "" }));
  await sync();
  await call(merchant, "dispatch")("respond_to_issue", { issue: report, accept: false });
  await sync();
  const declined = await viewOf(merchant, first);
  const flag = { target: { Customer: customer.agentPubKey }, order_ref: first, kind: { BadFaithReport: { reason: "ItemWasIncluded" } }, basis: declined.answer };
  await assert.rejects(raw(driver, flag), /cites its recorder's own answer/, "nobody but the store finds against its customer: the answer it cites is the store's");
  await assert.rejects(raw(merchant, { ...flag, target: { Driver: driver.agentPubKey }, kind: { DeliveryFaulted: { reason: "Late" } } }), /driver at fault only on a report on the delivery it refunded/, "nor a driver at fault on a report about items");
  await assert.rejects(raw(merchant, { ...flag, basis: first }), /cites its own answer/, "a finding cites the store's answer, nothing else");
  await call(merchant, "reputation")("record_finding", { order: first, issue: report, finding: { BadFaith: "ItemWasIncluded" } });
  await assert.rejects(call(merchant, "reputation")("record_finding", { order: first, issue: report, finding: { BadFaith: "Other" } }), /already said so/, "once per report");
  await sync();
  console.log("[PASS] only the order's store finds a report wasn't in good faith, on one about items it declined, once");

  // ===== Counted only from an established store =====
  assert.equal((await summary({ Customer: customer.agentPubKey })).bad_faith_stores, 0, "a store with one completed order isn't established: it doesn't count");
  assert.equal((await findings({ Customer: customer.agentPubKey }))[0].counts, false, "and the customer sees it isn't counted");
  await pickup();
  await retryUntil(() => summary({ Customer: customer.agentPubKey }), (s) => s.bad_faith_stores === 1, 30, 1000);
  console.log("[PASS] a store's finding counts once it's established");

  // ===== Answered once, by the one it's about =====
  const [found] = await findings({ Customer: customer.agentPubKey });
  await assert.rejects(call(driver, "reputation")("reply_to_finding", { event: found.event, text: "Not me" }), /only reply to what a store said about you/, "nobody else answers for them");
  await assert.rejects(call(driver, "reputation")("create_raw_mark_reply_for_testing", { event: found.event, text: "Not me" }), /only the one a mark is about replies/, "nor can a modified app");
  await assert.rejects(call(customer, "reputation")("create_raw_mark_reply_for_testing", { event: found.event, text: "x".repeat(281) }), /at most 280 characters/, "and a reply is short");
  await call(customer, "reputation")("reply_to_finding", { event: found.event, text: "The bag really was missing it." });
  await assert.rejects(call(customer, "reputation")("reply_to_finding", { event: found.event, text: "Again" }), /already replied/, "once");
  await sync();
  await retryUntil(() => findings({ Customer: customer.agentPubKey }), (f) => f[0].reply === "The bag really was missing it.");
  console.log("[PASS] the customer answers it once, publicly, and nobody else can");

  // ===== An appeal the customer wins clears it =====
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("settle_order", first).catch(() => 0);
      await payeeAgent(merchant).catch(() => 0);
      await sync();
      return call(customer, "dispatch")<{ refund: number | null }>("get_order_decisions", first);
    },
    (d) => d.refund !== null,
    150,
    1000,
  );
  const appeal = await call(customer, "dispatch")<Uint8Array>("file_appeal", { order: first, amount: 1000, note: "It was missing", photo_data_uri: "" });
  await sync();
  await retryUntilOk(() => call(arbiter, "dispatch")("rule_on_appeal", { appeal, award: 1000, reasons: "The store couldn't show it was there." }));
  await sync();
  await retryUntil(() => summary({ Customer: customer.agentPubKey }), (s) => s.bad_faith_stores === 0, 30, 1000);
  assert.equal((await findings({ Customer: customer.agentPubKey }))[0].counts, false, "the finding stays, shown not counting");
  console.log("[PASS] an appeal the customer wins clears the store's finding");

  // ===== The driver at fault: only on a delivery report the store refunded =====
  const delivery = actionHash(await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: 1000, tip_cents: 100 }));
  await sync();
  await acceptOrder(merchant, delivery, all);
  const bid = actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: delivery, eta_seconds: 600, price_offer: 500 }));
  await sync();
  await call(customer, "dispatch")("accept_bid", { order_original_action: delivery, bid_action: bid });
  await sync();
  await commitAndCook(driver, merchant, delivery, all);
  await collectFromStore(driver, merchant, delivery, all);
  await handOff(driver, customer, delivery, "CustomerHandoff", all);
  await sync();
  await call(customer, "dispatch")("complete_delivery", { order_original_action: delivery });
  await sync();
  const late = actionHash(await call(customer, "dispatch")<HcRecord>("report_issue", { order: delivery, lines: [], service: true, note: "Late -- 40 minutes", photo_data_uri: "" }));
  await sync();
  await assert.rejects(call(merchant, "reputation")("record_finding", { order: delivery, issue: late, finding: { DriverAtFault: "Late" } }), /Answer the report first/, "only once it's answered");
  await call(merchant, "dispatch")("respond_to_issue", { issue: late, accept: true, refund: 100 });
  await sync();
  const refunded = await viewOf(merchant, delivery);
  await assert.rejects(raw(merchant, { target: { Customer: customer.agentPubKey }, order_ref: delivery, kind: { BadFaithReport: { reason: "Other" } }, basis: refunded.answer }), /only on one about items it declined/, "never bad faith on a report about the delivery");
  await call(merchant, "reputation")("record_finding", { order: delivery, issue: late, finding: { DriverAtFault: "Late" } });
  await sync();
  await retryUntil(() => summary({ Driver: driver.agentPubKey }), (s) => s.faulted_count === 1, 30, 1000);
  const driverSees = await retryUntil(() => call(driver, "dispatch")<IssueView[]>("get_issues_for_order", delivery), (v) => v.length === 1);
  assert.equal(driverSees[0].evidence?.note, "Late -- 40 minutes", "the driver reads what the customer wrote");
  const [fault] = await findings({ Driver: driver.agentPubKey });
  assert.deepEqual(fault.finding, { DriverAtFault: "Late" });
  await assert.rejects(call(customer, "reputation")("reply_to_finding", { event: fault.event, text: "He was late" }), /only reply to what a store said about you/, "the customer doesn't answer for the driver");
  await call(driver, "reputation")("reply_to_finding", { event: fault.event, text: "The store had it ready 30 minutes late." });
  await sync();
  await retryUntil(() => findings({ Driver: driver.agentPubKey }), (f) => f[0].reply !== null);
  console.log("[PASS] a store holds its driver at fault only for a delivery it refunded; the driver reads the claim and answers it");
});
