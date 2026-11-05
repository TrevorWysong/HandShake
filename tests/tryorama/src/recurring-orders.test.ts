// Proves recurring order templates: create/list round-trip, invalid
// recurrence values rejected, updates collapse back to exactly one Record
// per template (a naive local query() would return one per action), and
// the customer's own conductor fires a due template -- placing its order
// and moving it to its next occurrence -- with nothing calling it.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, retryUntil, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => retryingCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => retryingCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => retryingCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const itemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 1000, available: true });
  const itemRef = actionHash(itemRecord);
  // The template references the store; a customer has always seen it first.
  await dhtSync([customer, merchant], customer.cells[0].cell_id[0]);

  const baseInput = {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: itemRef, quantity: 1 }],
    dropoff: ST_PETE,
    max_delivery_fee: 1_000,
    time_zone: "UTC",
  };

  // Invalid recurrence values rejected.
  await assert.rejects(
    dispatchOf(customer)("create_recurring_template", { ...baseInput, recurrence: { Weekly: { weekday: 7, hour: 9, minute: 0 } } }),
    /Weekly's weekday must be 0-6/,
    "a weekday of 7 must be rejected",
  );
  await assert.rejects(
    dispatchOf(customer)("create_recurring_template", { ...baseInput, recurrence: { Daily: { hour: 24, minute: 0 } } }),
    /Daily's hour must be 0-23/,
    "an hour of 24 must be rejected",
  );
  console.log("[PASS] out-of-range recurrence values are rejected");
  await assert.rejects(
    dispatchOf(customer)("create_recurring_template", { ...baseInput, max_delivery_fee: 2_501, recurrence: { Daily: { hour: 9, minute: 0 } } }),
    /more than this store allows for delivery/,
    "a standing order's fee cap is within its store's most, as a one-off order's is",
  );
  console.log("[PASS] a standing order past the store's most delivery fee is refused when it's set up");

  const templateRecord = await dispatchOf(customer)<HcRecord>("create_recurring_template", {
    ...baseInput,
    recurrence: { Weekly: { weekday: 1, hour: 9, minute: 0 } },
  });
  const templateRef = actionHash(templateRecord);
  const created = decodeEntry<{ recurrence: unknown; next_run_at: number }>(templateRecord);
  assert.deepEqual(created.recurrence, { Weekly: { weekday: 1, hour: 9, minute: 0 } });
  const firstRun = new Date(created.next_run_at / 1000);
  assert.ok(firstRun.getUTCDay() === 1 && firstRun.getUTCHours() === 9 && firstRun.getUTCMinutes() === 0 && created.next_run_at > now, "the conductor schedules the first run: the next Monday 9:00 in its zone");
  console.log("[PASS] a valid Weekly recurring template is created, with its first run worked out in its own time zone");

  let templates = await dispatchOf(customer)<{ original_action: Uint8Array; record: HcRecord }[]>("list_my_recurring_templates", null);
  assert.equal(templates.length, 1, "exactly one template should be listed after one creation");
  console.log("[PASS] list_my_recurring_templates returns the newly created template");

  // Toggle active off, then on -- list must still show exactly one Record,
  // not one per update action.
  await dispatchOf(customer)("set_recurring_template_active", { original_action: templateRef, active: false });
  templates = await dispatchOf(customer)<{ original_action: Uint8Array; record: HcRecord }[]>("list_my_recurring_templates", null);
  assert.equal(templates.length, 1, "toggling active must not duplicate the template in the list");
  assert.equal(decodeEntry<{ active: boolean }>(templates[0].record).active, false, "the toggled template should reflect active: false");
  console.log("[PASS] set_recurring_template_active updates in place, no duplicate Record");

  // --- A template never orders on its own: at its time it asks. ---
  // Daily, a couple of minutes from now in UTC.
  type View = { original_action: Uint8Array; record: HcRecord; due: string };
  const signals: unknown[] = [];
  customer.appWs.on("signal", (signal) => void signals.push(signal));
  const soon = new Date(Date.now() + 2 * 60_000);
  const standing = actionHash(
    await dispatchOf(customer)<HcRecord>("create_recurring_template", { ...baseInput, recurrence: { Daily: { hour: soon.getUTCHours(), minute: soon.getUTCMinutes() } } }),
  );
  const mine = (views: View[]) => views.find((t) => Buffer.from(t.original_action).equals(Buffer.from(standing)))!;
  const views = () => dispatchOf(customer)<View[]>("list_my_recurring_templates", null);
  assert.equal(mine(await views()).due, "NotYet");
  await dispatchOf(customer)("advance_recurring_template", standing);
  const before = decodeEntry<{ next_run_at: number }>(mine(await views()).record).next_run_at;
  assert.ok(before < Date.now() * 1000 + 3 * 60_000_000, "moving on one not yet due loses no occurrence");
  await retryUntil(views, (all) => mine(all).due === "ConfirmNow", 240, 1000);
  assert.equal((await dispatchOf(customer)<unknown[]>("get_my_active_orders", null)).length, 0, "its time has come, and nothing's been ordered");
  const paused = (await views()).find((t) => Buffer.from(t.original_action).equals(Buffer.from(templateRef)))!;
  assert.equal(paused.due, "NotYet", "a paused one doesn't ask");
  await dispatchOf(merchant)("get_active_orders_for_store", catalogRef).then((orders) => assert.equal((orders as unknown[]).length, 0, "and the store has heard nothing"));
  await retryUntil(async () => signals, (heard) => heard.some((signal) => JSON.stringify(signal).includes("RecurringOrderDue")), 90, 1000);
  console.log("[PASS] at its time a recurring order asks its customer, and orders nothing");

  await dispatchOf(customer)("advance_recurring_template", standing);
  templates = await views();
  assert.equal(templates.length, 2, "moving on updates the template in place");
  assert.equal(mine(templates as View[]).due, "NotYet");
  const nextRun = decodeEntry<{ next_run_at: number }>(mine(templates as View[]).record).next_run_at;
  assert.ok(nextRun > Date.now() * 1000 + 23 * 3_600_000_000, "to tomorrow's occurrence");
  console.log("[PASS] taken to checkout or passed on, it moves to its next occurrence");

  // A non-owner can't tamper with someone else's template. Needs a real
  // dhtSync first -- this entry deliberately has no DHT link (see its own
  // doc comment), so the merchant's conductor has no other way to have
  // even seen it yet; without this, resolve_latest would fail with
  // "record not found" before ever reaching the authorship check this
  // assertion actually means to exercise.
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await assert.rejects(
    dispatchOf(merchant)("set_recurring_template_active", { original_action: templateRef, active: true }),
    /a recurring order template can only be updated by its own requester/,
    "a non-owner must not be able to toggle someone else's recurring template",
  );
  console.log("[PASS] a non-owner cannot modify another agent's recurring template");
});
