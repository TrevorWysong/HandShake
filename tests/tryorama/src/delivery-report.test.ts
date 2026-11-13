// Proves a customer can tell the store a delivery itself let them down --
// late, cold, spilled -- and that the store, not the driver, answers for it:
//
// - only on a delivery a driver brought, naming no items, once, and only by
//   its customer; it's worth their share of the fee for that driver;
// - the store answers it as any report -- all, part or none -- within the
//   same bounds;
// - settled, the customer gets their share of the fee back out of what the
//   store collects for the food, and the driver is paid in full.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, collectFromStore, commitAndCook, handOff, netOn, payeeAgent, retryUntil, retryingCaller, setupPlayersWithProperties, ST_PETE, useTestCoordinators } from "./helpers.js";

/// Long enough to report in, short enough to wait out.
const REPORT_WINDOW_SECS = 60;
const FOOD = 600;
const BID = 500;
const TIP = 100;
/// The customer's half of the bid, at the store's default 50/50 split.
const CUSTOMER_SHARE = 250;

interface IssueView {
  service: boolean;
  value: number;
  accepted: boolean | null;
  refund: number | null;
}

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await setupPlayersWithProperties(scenario, 3, () => ({ report_window_secs: REPORT_WINDOW_SECS }));
  const all = [customer, merchant, driver];
  for (const p of all) await useTestCoordinators(p, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const raw = (p: typeof customer, fn: string, input: unknown) => call(p, "dispatch")(`create_raw_${fn}_for_testing`, input);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const empanada = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Empanada", price_cents: FOOD, available: true }));
  await sync();

  // A delivery, brought by the driver and completed by the customer.
  const order = actionHash(
    await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: empanada, quantity: 1 }], order_total: FOOD, dropoff: ST_PETE, max_delivery_fee: 1_000, tip_cents: TIP }),
  );
  await sync();
  await acceptOrder(merchant, order, all);
  const bid = actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: BID }));
  await sync();
  await call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: bid });
  await sync();
  await commitAndCook(driver, merchant, order, all);
  await collectFromStore(driver, merchant, order, all);
  await handOff(driver, customer, order, "CustomerHandoff", all);
  await sync();
  await call(customer, "dispatch")("complete_delivery", { order_original_action: order });
  await sync();

  // What the customer could report: what it'd be worth.
  const items = await call(customer, "dispatch")<{ delivery_report_worth: number | null }>("get_issue_items", order);
  assert.equal(items.delivery_report_worth, CUSTOMER_SHARE, "a delivery report is worth the customer's share of the driver's fee");

  // Who can report it, and how.
  await assert.rejects(raw(merchant, "item_issue", { order, lines: [], service: true }), /only the order's customer/, "only the customer reports the delivery");
  await assert.rejects(raw(customer, "item_issue", { order, lines: [{ line: 0, quantity: 1, kind: "Missing" }], service: true }), /names no items/, "a report on the delivery names no items");
  console.log("[PASS] only the customer reports the delivery itself, naming no items");

  const report = actionHash(await call(customer, "dispatch")<HcRecord>("report_issue", { order, lines: [], service: true, note: "Late -- 40 minutes", photo_data_uri: "" }));
  await sync();
  await assert.rejects(raw(customer, "item_issue", { order, lines: [], service: true }), /and its delivery, is reported once/, "the delivery is reported once");
  await assert.rejects(call(customer, "dispatch")("report_issue", { order, lines: [], service: true, note: "", photo_data_uri: "" }), /already told the store about the delivery/, "and the app says so first");
  const views = await retryUntil(() => call(merchant, "dispatch")<IssueView[]>("get_issues_for_order", order), (v) => v.length === 1);
  assert.deepEqual([views[0].service, views[0].value], [true, CUSTOMER_SHARE], "the store sees a delivery report worth the customer's share of the fee");
  console.log("[PASS] reported once, worth the customer's share of the fee for the driver who brought it");

  // The store answers it as any report, within the same bounds.
  await assert.rejects(raw(merchant, "issue_response", { issue: report, accept: true, refund: CUSTOMER_SHARE }), /partial refund/, "a part is less than all it's worth");
  await call(merchant, "dispatch")("respond_to_issue", { issue: report, accept: true, refund: 150 });
  await sync();

  // Settled: 1.50 of the customer's 2.50 back, from the store; the driver
  // keeps the whole bid and the tip.
  const settled = await retryUntil(
    async () => {
      await call(merchant, "dispatch")("settle_order", order).catch(() => 0);
      await payeeAgent(merchant).catch(() => 0);
      await payeeAgent(driver).catch(() => 0);
      await sync();
      return call(customer, "dispatch")<{ refund: number | null }>("get_order_decisions", order);
    },
    (d) => d.refund !== null,
    150,
    1000,
  );
  assert.equal(settled.refund, 150, "the store's settlement refunds the part it named");
  const nets = () => Promise.all([netOn(customer, order), netOn(merchant, order), netOn(driver, order)]);
  const [customerNet, merchantNet, driverNet] = await retryUntil(nets, ([c, , d]) => c === -(FOOD + CUSTOMER_SHARE + TIP - 150) && d === BID + TIP, 120, 1000);
  assert.equal(customerNet, -(FOOD + CUSTOMER_SHARE + TIP - 150), "the customer pays 1.50 less");
  assert.equal(driverNet, BID + TIP, "the driver is paid the whole bid and the tip");
  assert.equal(merchantNet, FOOD - 150 - (BID - CUSTOMER_SHARE), "the store pays it: its food less the refund, less its share of the fee");
  console.log("[PASS] the store refunds the delivery out of its own takings -- never from the driver");
});
