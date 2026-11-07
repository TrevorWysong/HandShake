// Proves what happens when nobody comes for an order -- each side
// protected, everything disputable, and the money following one decision:
//
// - A delivery nobody comes to the door for: once its driver has recorded
//   arriving and waited the network's wait, proved, they can say so. Unless
//   the customer disputes it and the store sides with them, it's paid as
//   delivered once the customer's report window has run, and counts against
//   the customer. The customer can still take it meanwhile.
// - A customer who says they were there: the store decides. Sided with,
//   they pay nothing and the driver's collateral pays for the food.
// - A pickup nobody comes for: once the collection window from its being
//   ready has passed, proved, the store keeps the food's price.
// - A customer who says they can't get theirs: once, and the store decides.
//   It cancels, and nobody's charged, or it says it's ready, which starts
//   their window again -- as does its silence. They can't say so twice.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { FULL_SIZE_PHOTO, acceptOrder, actionHash, collectFromStore, commitAndCook, currentBeacon, customerPaid, decodeEntry, netOn, retryUntil, retryUntilOk, settleAll, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

const FOOD = 1000;
const FEE = 400;
const TIP = 150;
/// Seconds: the driver's wait at the door -- short, to wait out -- and a
/// customer's to collect, long enough that setting a pickup up never runs
/// past it; a report window long enough to dispute in first.
const DOOR_WAIT = 2;
const COLLECT_WAIT = 15;
/// Seconds a store has to answer before its silence does: past the wait to
/// collect, which a report holds off until then.
const ANSWER_GRACE = 45;
/// The time source's rounds are seconds apart: waiting this much past a
/// deadline proves it.
const past = (secs: number) => (secs + 8) * 1000;

interface Summary {
  no_show_count: number;
  cancelled_by_them_count: number;
  dispute_resolved_against_count: number;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/// A photo of the door -- one pixel's worth.
const DOOR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await setupPlayersWithProperties(scenario, 3, () => ({ dropoff_wait_secs: DOOR_WAIT, collection_window_secs: COLLECT_WAIT, answer_grace_secs: ANSWER_GRACE, report_window_secs: 20 }));
  const all = [customer, merchant, driver];
  for (const p of all) await useTestCoordinators(p, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const summary = (target: object) => call(merchant, "reputation")<Summary>("get_reputation_summary", target);
  const statusOf = async (ref: Uint8Array) => decodeEntry<{ status: string; cancellation: unknown }>(await call(customer, "dispatch")<HcRecord>("get_order", ref));
  const latestVersion = async (ref: Uint8Array) => actionHash(await call(customer, "dispatch")<HcRecord>("get_order", ref));

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: FOOD, available: true }));
  await sync();

  /// A delivery picked up on the store's confirmation, out for delivery.
  async function outForDelivery() {
    const ref = actionHash(
      await retryUntilOk(() =>
        call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: FOOD, dropoff: ST_PETE, max_delivery_fee: 1_000, tip_cents: TIP }),
      ),
    );
    await sync();
    await acceptOrder(merchant, ref, all);
    const bid = actionHash(await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: ref, eta_seconds: 600, price_offer: FEE })));
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("accept_bid", { order_original_action: ref, bid_action: bid }));
    await sync();
    await commitAndCook(driver, merchant, ref, all);
    await collectFromStore(driver, merchant, ref, all);
    await sync();
    return ref;
  }
  /// The driver at the door: arriving recorded (the customer's told).
  const arrive = (ref: Uint8Array, photo = DOOR) => call(driver, "attestation")<HcRecord>("record_leg", { order_ref: ref, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE, photo_data_uri: photo });
  const notHere = async (ref: Uint8Array) => call(driver, "dispatch")<HcRecord>("customer_not_here", { order_ref: ref, beacon: await currentBeacon() });

  // ===== Nobody comes to the door =====
  const unanswered = await outForDelivery();
  await assert.rejects(notHere(unanswered), /Record that you've arrived first/, "a driver says nobody came only once they've recorded arriving");
  await arrive(unanswered, "");
  await sleep(past(DOOR_WAIT));
  await assert.rejects(notHere(unanswered), /Take a photo of the door/, "with a photo of the door");
  await arrive(unanswered);
  await assert.rejects(notHere(unanswered), /still has time to come to the door/, "nor before the network's wait");
  await assert.rejects(call(customer, "dispatch")("customer_not_here", { order_ref: unanswered, beacon: await currentBeacon() }), /Only the order's driver/, "and only its driver");
  await sleep(past(DOOR_WAIT));
  await retryUntilOk(() => notHere(unanswered));
  await sync();
  assert.equal((await statusOf(unanswered)).status, "Unanswered");
  const word = await latestVersion(unanswered);
  await assert.rejects(call(merchant, "dispatch")("create_raw_outcome_for_testing", { order: unanswered, outcome: { Delivered: { proof: word } } }), /only once the customer's report window has run/, "the store can't uphold it before the customer could dispute it");
  console.log("[PASS] a driver says nobody came only from the door, after the wait, proved");

  // Undisputed: upheld once the report window has run, paid as delivered.
  await settleAll(all, unanswered);
  assert.equal(await netOn(customer, unanswered), -(FOOD + FEE / 2 + TIP), "the customer pays as for a delivery");
  assert.equal(await netOn(driver, unanswered), FEE + TIP, "the driver is paid the whole fee and the tip");
  assert.equal(await netOn(merchant, unanswered), FOOD - FEE / 2, "the store, the food less its half of the fee");
  await retryUntil(() => summary({ Customer: customer.agentPubKey }), (s) => s.no_show_count === 1);
  console.log("[PASS] upheld after the report window: paid as delivered, and counted against the customer");

  // ===== The customer was there after all, and takes it =====
  const takenLate = await outForDelivery();
  const arrival = actionHash(await arrive(takenLate));
  await sleep(past(DOOR_WAIT));
  await retryUntilOk(() => notHere(takenLate));
  await sync();
  await retryUntilOk(() => call(customer, "attestation")("acknowledge_leg", arrival));
  await retryUntilOk(() => call(customer, "dispatch")("complete_delivery", { order_original_action: takenLate }));
  await sync();
  assert.equal((await statusOf(takenLate)).status, "Delivered", "the customer can still take it, with the same proof");
  console.log("[PASS] a customer who comes to the door after all still takes it");

  // ===== The customer says they were there; the store sides with them =====
  const disputed = await outForDelivery();
  // A full-size photo: the store's sealed copy of it fits as the customer's does.
  await arrive(disputed, FULL_SIZE_PHOTO);
  await sleep(past(DOOR_WAIT));
  await retryUntilOk(() => notHere(disputed));
  await sync();
  await call(customer, "dispatch")("claim_never_arrived", disputed);
  await sync();
  // The store decides on more than each side's word: the driver's photo of
  // the door, and how far off they were by the customer's app -- never
  // anyone's coordinates. Nobody else sees either.
  type Evidence = { door_photo: string | null; arrived_metres: number | null };
  const evidence = await retryUntil(() => call(merchant, "dispatch")<Evidence>("arrival_evidence", disputed), (e) => e.door_photo !== null && e.arrived_metres !== null);
  assert.equal(evidence.door_photo, FULL_SIZE_PHOTO, "the store sees the driver's photo of the door");
  assert.ok(evidence.arrived_metres! < 50, "and that the driver recorded arriving at the customer's address");
  assert.deepEqual(await call(driver, "dispatch")<Evidence>("arrival_evidence", disputed), { door_photo: null, arrived_metres: null }, "only the store reads it");
  // And only the order's customer and driver give it: not the store itself.
  const version = actionHash(await call(merchant, "dispatch")<HcRecord>("get_order", disputed));
  const sealed = [{ nonce: Array(24).fill(0), encrypted_data: new Uint8Array(16) }];
  await assert.rejects(merchant.cells[0].callZome({ zome_name: "dispatch", fn_name: "create_raw_payment_record_for_testing", payload: { Evidence: { order: disputed, version, sealed } } }), /only an order's customer or its driver/, "nobody else gives a store evidence");
  const decisions = await call(merchant, "dispatch")<{ no_show_upheld_after: number | null; claim_decided_after: number | null }>("get_order_decisions", disputed);
  assert.ok(decisions.no_show_upheld_after !== null && decisions.claim_decided_after === null, "a disputed no-show is upheld unless the store sides with the customer -- not refunded by default");
  await retryUntilOk(() => call(merchant, "dispatch")("decide_not_delivered", disputed));
  await settleAll(all, disputed);
  assert.equal(await netOn(customer, disputed), 0, "sided with, the customer pays nothing");
  assert.equal(await netOn(driver, disputed), -FOOD, "the driver's collateral pays for the food");
  assert.equal(await netOn(merchant, disputed), FOOD, "the store is paid for the food either way");
  await retryUntil(() => summary({ Driver: driver.agentPubKey }), (s) => s.dispute_resolved_against_count === 1);
  console.log("[PASS] a customer who says they were there is decided by the store, on the driver's photo and how far off they were -- sided with, refunded, against the driver");

  // ===== A pickup nobody comes for =====
  const pickup = async () => {
    const ref = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: FOOD })));
    await sync();
    await customerPaid(merchant, ref, all);
    await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: ref }));
    await call(merchant, "dispatch")("mark_ready_for_pickup", ref);
    await sync();
    return ref;
  };
  const neverCame = (ref: Uint8Array) => async () => call(merchant, "dispatch")<HcRecord>("mark_pickup_not_collected", { order_ref: ref, beacon: await currentBeacon() });
  const uncollected = await pickup();
  await assert.rejects(neverCame(uncollected)(), /still has time to collect it/, "the store waits out the customer's window");
  await sleep(past(COLLECT_WAIT));
  await retryUntilOk(neverCame(uncollected));
  await sync();
  const ended = await statusOf(uncollected);
  assert.deepEqual([ended.status, ended.cancellation], ["Cancelled", "NotCollected"]);
  await settleAll(all, uncollected);
  assert.equal(await netOn(customer, uncollected), -FOOD, "the customer pays for the food the store made");
  assert.equal(await netOn(merchant, uncollected), FOOD, "the store is paid for it");
  await retryUntil(() => summary({ Customer: customer.agentPubKey }), (s) => s.cancelled_by_them_count === 1);
  console.log("[PASS] a ready pickup nobody comes for: past the window, the store keeps the food's price, counted against the customer");

  // Said they can't get it: the store answers instead.
  const cantGet = await pickup();
  await call(customer, "dispatch")("report_pickup_problem", cantGet);
  await sync();
  await sleep(past(COLLECT_WAIT));
  await assert.rejects(neverCame(cantGet)(), /Only the store records a ready order/, "never one the customer has said they can't get");
  console.log("[PASS] ...not while a customer's saying they can't get it, until the store has answered");

  const stranger = (ref: Uint8Array) => call(customer, "dispatch")("dismiss_pickup_problem", ref);
  await assert.rejects(stranger(cantGet), /Only the store answers/, "the customer doesn't answer for the store");
  await retryUntilOk(() => call(merchant, "dispatch")("dismiss_pickup_problem", cantGet));
  await sync();
  assert.equal((await statusOf(cantGet)).status, "ReadyForPickup", "the store says it's ready");
  const dismissed = await retryUntil(() => call(customer, "dispatch")<{ report_dismissed: boolean }>("get_order_decisions", cantGet), (d) => d.report_dismissed);
  assert.equal(dismissed.report_dismissed, true);
  await assert.rejects(call(customer, "dispatch")("report_pickup_problem", cantGet), /already answered/, "they can't say it again");
  await assert.rejects(customer.cells[0].callZome({ zome_name: "dispatch", fn_name: "report_pickup_problem_unchecked_for_testing", payload: cantGet }), /once: the store has answered/, "nor can a modified app");
  await assert.rejects(neverCame(cantGet)(), /still has time to collect it/, "their window to collect it starts again");
  await sleep(past(COLLECT_WAIT));
  await retryUntilOk(neverCame(cantGet));
  await sync();
  await settleAll(all, cantGet);
  assert.equal(await netOn(customer, cantGet), -FOOD, "not collecting it, they pay for the food the store made");
  assert.equal(await netOn(merchant, cantGet), FOOD);
  console.log("[PASS] a store that says it's ready has the last word: past their new window, a customer who didn't collect it pays");

  const silent = await pickup();
  await call(customer, "dispatch")("report_pickup_problem", silent);
  await sync();
  await sleep(past(ANSWER_GRACE));
  const answered = await retryUntil(async () => {
    await call(merchant, "dispatch")("settle_order", silent);
    return statusOf(silent);
  }, (order) => order.status === "ReadyForPickup");
  assert.equal(answered.status, "ReadyForPickup", "its conductor answers for it");
  await sync();
  assert.equal(await netOn(customer, silent), 0, "a store's silence charges nobody by itself");
  console.log("[PASS] a store's silence is its answer that it's ready, and charges nobody by itself");

  const agreed = await pickup();
  await call(customer, "dispatch")("report_pickup_problem", agreed);
  await sync();
  await retryUntilOk(() => call(merchant, "dispatch")("decline_pickup_order", { order_original_action: agreed, reason: "Other" }));
  await sync();
  await settleAll(all, agreed);
  assert.equal(await netOn(customer, agreed), 0, "a store that agrees cancels it, and nobody's charged");
  assert.equal(await netOn(merchant, agreed), 0);
  console.log("[PASS] a store that agrees cancels it, and nobody's charged");
});
