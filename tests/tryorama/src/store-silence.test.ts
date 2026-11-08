// Proves a delivery never waits forever on a party gone quiet:
//
// - a store silent on an order it owes the next step -- one a driver left
//   cooking, one with a driver at its counter -- is closed by its customer
//   past the network's lapse, with nobody charged but the store, which pays
//   a driver it had checked in;
// - an order merely waiting on drivers can't be closed on its store: its
//   customer cancels it for nothing instead;
// - a customer collecting it has the network's window from when it's due
//   ready, however early the store records them coming -- and one who has
//   it can't close it as lapsed on another branch of its history;
// - a delivery picked up that never arrives is said never to have by its
//   customer's own app, past the lapse, so the driver who kept the food pays
//   for it.
//
// Each refusal is proved on a write past the honest app's checks, so it's
// the network that holds it.
import assert from "node:assert/strict";
import { runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, collectFromStore, currentBeacon, deliveryStatus, retryUntil, retryUntilOk } from "./helpers.js";
import { FEE, FOOD, lateOrderWorld, sleepUntil, type PinSecret } from "./late-orders.world.js";

/// Seconds the network lets an order sit before its customer may close it:
/// past the window to collect and the store's time to answer.
const LAPSE = 20;
const COLLECT_WAIT = 10;

await runScenario(async (scenario) => {
  const { customer, merchant, first, second, store, call, sync, settlesTo, timing, placed, driving, drop } = await lateOrderWorld(scenario, {
    collection_window_secs: COLLECT_WAIT,
    order_lapse_secs: LAPSE,
    claim_grace_secs: 2,
  });
  const dispatch = (p: typeof customer, fn_name: string, payload: unknown) => p.cells[0].callZome<HcRecord>({ zome_name: "dispatch", fn_name, payload });
  const closeOnStore = async (order: Uint8Array) => dispatch(customer, "lapse_delivery_order", { order_ref: order, beacon: await currentBeacon() });
  /// The customer writing the cancellation themselves, past every check the
  /// app makes -- what a modified client could.
  const forceLapse = async (order: Uint8Array) => dispatch(customer, "force_order_update_for_testing", { order_original_action: order, next_status: "Cancelled", delivery_receipts: [], cancellation: "Lapsed", beacon: await currentBeacon() });
  const lapsesAt = async (order: Uint8Array) => {
    const at = (await timing(order)).lapses_at;
    assert.ok(at, "the store owes this order its next step");
    return at;
  };

  // Every order first, so their lapses run together.
  // A driver leaves one cooking, and the store never ends it.
  const leftCooking = await placed();
  await driving(leftCooking, first);
  await drop(leftCooking, first);
  // The store has its time first: its lapse runs from the food's ready time.
  await assert.rejects(closeOnStore(leftCooking), /still has time to answer/, "the store has its time first");
  await assert.rejects(forceLapse(leftCooking), /silent on it long enough/, "the network holds it too");
  await assert.rejects(dispatch(merchant, "lapse_delivery_order", { order_ref: leftCooking, beacon: await currentBeacon() }), /Only the customer closes/);
  // One merely waiting on drivers.
  const waiting = await placed();
  // One with a driver at the counter, and the store gone quiet.
  const atCounter = await placed();
  await driving(atCounter, second);
  const code = await call(merchant, "dispatch")<PinSecret>("get_my_pickup_code", atCounter);
  await retryUntilOk(() => call(second, "attestation")("check_in_at_store", { order_ref: atCounter, code: code.pin }));
  await sync();
  assert.equal(await deliveryStatus(customer, atCounter), "DriverAtStore");
  // One its customer collects, the store recording them coming before the
  // kitchen's started.
  const collecting = await placed();
  await call(customer, "dispatch")("request_collect", collecting);
  await sync();
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("record_collecting", { order_ref: collecting, beacon: await currentBeacon() }).catch(() => null);
      return deliveryStatus(customer, collecting);
    },
    (s) => s === "Collecting",
    60,
    1000,
  );
  await sync();
  const collectingOrder = await call(customer, "dispatch")<HcRecord>("get_order", collecting);
  const collectingVersion = actionHash(collectingOrder);
  const recordedAt = collectingOrder.signed_action.hashed.content.header.timestamp;

  // ===== Only once the store owes the next step =====
  assert.equal((await timing(waiting)).lapses_at, null, "nothing's owed by a store whose order waits on drivers");
  await assert.rejects(closeOnStore(waiting), /isn't waiting on its store/);
  await assert.rejects(forceLapse(waiting), /only while the store owes its next step/, "the network holds it too");
  await retryUntilOk(() => call(customer, "dispatch")("cancel_order", waiting));
  await sync();
  await settlesTo(customer, waiting, 0, "its customer cancels it for nothing instead");
  console.log("[PASS] an order merely waiting on drivers is cancelled for nothing, never closed on its store");

  // ===== A customer collecting it has until its window from being ready =====
  const collectBy = (await timing(collecting)).collect_by;
  assert.ok(collectBy, "the customer's window is running");
  assert.ok(collectBy - recordedAt > COLLECT_WAIT * 1_000_000, "it runs from when the food's due ready, not from the store recording them coming");
  await sleepUntil(recordedAt + COLLECT_WAIT * 1_000_000);
  await assert.rejects(
    dispatch(merchant, "force_order_update_for_testing", { order_original_action: collecting, next_status: "Cancelled", delivery_receipts: [], cancellation: "NotCollected", beacon: await currentBeacon() }),
    /customer's window has passed/,
    "not while the food isn't due yet, however long since the store recorded them coming",
  );
  await retryUntilOk(() => call(customer, "dispatch")("confirm_collected", collecting));
  await sync();
  console.log("[PASS] a customer collecting a delivery has the network's window from when it's due ready");

  // ===== The store silent on a driver who left it cooking =====
  await sleepUntil(await lapsesAt(leftCooking));
  await retryUntilOk(() => closeOnStore(leftCooking));
  await sync();
  await settlesTo(customer, leftCooking, 0, "the customer pays nothing");
  await settlesTo(merchant, leftCooking, 0, "the store is paid nothing for the food it never ended the order on");
  await settlesTo(first, leftCooking, 0, "the driver who left it no longer answers for it");
  await retryUntil(() => call(customer, "reputation")<{ lapsed_count: number }>("get_reputation_summary", { Store: store }), (s) => s.lapsed_count === 1, 60, 1000);
  console.log("[PASS] a store silent on an order a driver left cooking is closed by its customer, with nobody charged, against the store");

  // ===== The store silent with a driver at its counter =====
  await sleepUntil(await lapsesAt(atCounter));
  await retryUntilOk(() => closeOnStore(atCounter));
  await sync();
  await settlesTo(second, atCounter, FEE, "the store pays the driver it checked in, as if it kept them waiting");
  await settlesTo(merchant, atCounter, -FEE, "the store pays it");
  await settlesTo(customer, atCounter, 0, "the customer pays nothing");
  console.log("[PASS] a store silent with a driver at its counter pays them, and charges its customer nothing");

  // ===== A customer who has it never closes it as lapsed =====
  await sleepUntil(collectBy - COLLECT_WAIT * 1_000_000 + LAPSE * 1_000_000);
  await assert.rejects(
    dispatch(customer, "branch_order_for_testing", { version: collectingVersion, next_status: "Cancelled", cancellation: "Lapsed", beacon: await currentBeacon() }),
    /has an order doesn't close it as lapsed/,
    "not on another branch of its history",
  );
  console.log("[PASS] a customer who has an order can't close it as lapsed on another branch");

  // ===== Picked up, and never brought =====
  const keptIt = await placed();
  await driving(keptIt, first);
  await collectFromStore(first, merchant, keptIt, [customer, merchant, first, second]);
  await sync();
  assert.equal(await deliveryStatus(customer, keptIt), "PickedUp");
  const pickedUp = await call(customer, "dispatch")<HcRecord>("get_order", keptIt);
  const tend = () => call(customer, "dispatch")("tend_one_order", { order: keptIt, version: actionHash(pickedUp) });
  await tend();
  assert.equal(await deliveryStatus(customer, keptIt), "PickedUp", "the driver has their time to bring it");
  await sleepUntil(pickedUp.signed_action.hashed.content.header.timestamp + LAPSE * 1_000_000);
  await retryUntil(
    async () => {
      await tend().catch(() => null);
      return deliveryStatus(customer, keptIt);
    },
    (s) => s === "Disputed",
    30,
    1000,
  );
  await sync();
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("decide_order", keptIt).catch(() => false);
      return call(merchant, "dispatch")<{ not_delivered: unknown }>("get_order_decisions", keptIt);
    },
    (d) => d.not_delivered !== null,
    60,
    1000,
  );
  await settlesTo(customer, keptIt, 0, "the customer pays nothing for food that never came");
  await settlesTo(first, keptIt, -FOOD, "the driver who kept it pays for it");
  await settlesTo(merchant, keptIt, FOOD, "the store is paid for the food");
  console.log("[PASS] a delivery picked up and never brought is said never to have arrived by its customer's app, and its driver pays for the food");
});
