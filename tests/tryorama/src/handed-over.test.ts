// Proves that once the food leaves the store, the store is the one who gets
// paid, and that no party's modified app can change that:
//
// - a store that's handed an order over -- to a driver, or to its customer
//   collecting it -- can't call it off, on any branch of its history; nor
//   can a store that called it off hand it over after;
// - a driver who's taken an order from the store can't drop it, and the
//   store records the pickup on its own record of handing it over, should
//   the driver's app never say;
// - a delivery picked up that nobody says more of -- no proof it arrived,
//   no claim it didn't -- is settled as delivered once the customer's time
//   to say otherwise has run, proved, and never before: the store is paid
//   for the food, the driver for the drive.
//
// Each refusal is proved on a write past the honest app's checks, so it's
// the network that holds it.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, bytesEqual, collectFromStore, decodeEntry, currentBeacon, deliveryStatus, handOff, netOn, payeeAgent, paymentsOn, retryUntil, retryUntilOk, ST_PETE, useTestCoordinators } from "./helpers.js";
import { FEE, FOOD, lateOrderWorld, sleepUntil, type PinSecret } from "./late-orders.world.js";

/// Seconds the network gives a customer to say a picked-up order never came,
/// and their report window after it.
const LAPSE = 20;
const REPORT_WINDOW = 5;
const BY_STORE = { ByStore: "OutdatedPrices" };

await runScenario(async (scenario) => {
  const { customer, merchant, first, second, all, call, sync, placed, driving } = await lateOrderWorld(scenario, {
    collection_window_secs: 10,
    order_lapse_secs: LAPSE,
    report_window_secs: REPORT_WINDOW,
    max_concurrent_deliveries: 5,
  });
  await useTestCoordinators(merchant, ["attestation"]);
  const dispatch = <T = unknown>(p: typeof customer, fn_name: string, payload: unknown) => p.cells[0].callZome<T>({ zome_name: "dispatch", fn_name, payload });
  const latest = (order: Uint8Array) => call(merchant, "dispatch")<HcRecord>("get_order", order);
  /// `p` updating one exact version of an order, past every check the app
  /// makes -- what a modified client could.
  const branch = (p: typeof customer, version: Uint8Array, next_status: string, extra: Record<string, unknown> = {}) =>
    dispatch(p, "branch_order_for_testing", { version, next_status, ...extra });
  /// The store checking `driver` in at its counter, on their code: the
  /// order's version that records it, and the one before.
  async function checkedIn(order: Uint8Array, driver: typeof customer) {
    const code = await call(merchant, "dispatch")<PinSecret>("get_my_pickup_code", order);
    await retryUntilOk(() => call(driver, "attestation")("check_in_at_store", { order_ref: order, code: code.pin }));
    await sync();
    const version = await retryUntil(() => latest(order), (r) => statusOf(r) === "DriverAtStore");
    // And the one before it -- the store's to move a late driver on from.
    const before = (version.signed_action.hashed.content.data as { original_action_address: Uint8Array }).original_action_address;
    return [actionHash(version), before] as const;
  }
  /// `driver`'s own record of taking `order` from the store.
  const takes = async (order: Uint8Array, driver: typeof customer) => {
    const leg = actionHash(
      await retryUntilOk(() =>
        call(driver, "attestation")<HcRecord>("record_leg", { order_ref: order, sequence: 0, kind: "MerchantHandoff", to: merchant.agentPubKey, geo_at_completion: ST_PETE, photo_data_uri: "" }),
      ),
    );
    await sync();
    return leg;
  };

  // ===== Handed to a driver, the store can't call it off =====
  const handed = await placed();
  await driving(handed, first);
  const [handedAtCounter, handedBeforeCheckIn] = await checkedIn(handed, first);
  await handOff(first, merchant, handed, "MerchantHandoff", all);
  await retryUntil(() => deliveryStatus(merchant, handed), (s) => s === "PickedUp", 60, 1000);
  await assert.rejects(branch(merchant, handedAtCounter, "Cancelled", { cancellation: BY_STORE }), /handed an order over can't take it back/, "not on the version before it left");
  await assert.rejects(branch(merchant, handedBeforeCheckIn, "Open", { release: true, beacon: await currentBeacon() }), /handed an order over can't take it back/, "nor move its driver on, to have them answer for food they carry");
  console.log("[PASS] a store that's handed an order to its driver can't call it off or move its driver on, on any branch");

  // ===== A driver who's taken it can't drop it; the store records the pickup =====
  const taken = await placed();
  await driving(taken, second);
  const [takenAtCounter] = await checkedIn(taken, second);
  const takenLeg = await takes(taken, second);
  await assert.rejects(call(second, "dispatch")("drop_order", { order_ref: taken, beacon: await currentBeacon() }), /taken an order from its store can't leave it/);
  const receipt = actionHash(await retryUntilOk(() => call(merchant, "attestation")<HcRecord>("acknowledge_leg", takenLeg)));
  await sync();
  await assert.rejects(branch(customer, takenAtCounter, "PickedUp", { pickup_proof: receipt }), /requires author role/, "only the driver, or the store, records the pickup");
  await retryUntilOk(() => branch(merchant, takenAtCounter, "PickedUp", { pickup_proof: receipt }));
  console.log("[PASS] a driver who's taken an order from the store can't drop it, and the store records the pickup on its own record");

  // ===== A store that called it off can't hand it over after =====
  const calledOff = await placed();
  await driving(calledOff, first);
  const [calledOffAtCounter] = await checkedIn(calledOff, first);
  const calledOffLeg = await takes(calledOff, first);
  await retryUntilOk(() => dispatch(merchant, "force_order_update_for_testing", { order_original_action: calledOff, next_status: "Cancelled", delivery_receipts: [], cancellation: BY_STORE }));
  const lateReceipt = await merchant.cells[0].callZome<Uint8Array>({ zome_name: "attestation", fn_name: "create_raw_receipt_for_testing", payload: { leg: calledOffLeg, attested_at: Date.now() * 1000 } });
  await sync();
  await assert.rejects(branch(first, calledOffAtCounter, "PickedUp", { pickup_proof: lateReceipt }), /called an order off can't hand it over/);
  console.log("[PASS] a store that called an order off can't then hand it over");

  // ===== Handed to its customer, the store can't call it off =====
  const collected = await placed();
  await call(customer, "dispatch")("request_collect", collected);
  await sync();
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("record_collecting", { order_ref: collected, beacon: await currentBeacon() }).catch(() => null);
      return deliveryStatus(customer, collected);
    },
    (s) => s === "Collecting",
    60,
    1000,
  );
  await sync();
  const collectingVersion = actionHash(await latest(collected));
  const code = await call(customer, "dispatch")<PinSecret>("get_my_handover_code", collected);
  await retryUntilOk(() => call(merchant, "dispatch")("hand_over_collection", { order_original_action: collected, code }));
  await sync();
  await assert.rejects(branch(merchant, collectingVersion, "Cancelled", { cancellation: BY_STORE }), /handed an order over can't take it back/);
  await assert.rejects(branch(merchant, collectingVersion, "Cancelled", { cancellation: "NotCollected", beacon: await currentBeacon() }), /handed an order over can't take it back/);
  console.log("[PASS] a store that's handed an order to its customer can't call it off, or say it was never collected");

  // ===== Picked up, and nobody says more =====
  const stalled = await placed();
  await driving(stalled, second);
  await collectFromStore(second, merchant, stalled, all);
  const pickedUp = await retryUntil(() => latest(stalled), (r) => statusOf(r) === "PickedUp");
  const settlesAt = pickedUp.signed_action.hashed.content.header.timestamp + (LAPSE + REPORT_WINDOW) * 1_000_000;
  const settle = async () => dispatch<Uint8Array>(merchant, "settle_stalled_delivery", { order_ref: stalled, beacon: await currentBeacon() });
  await assert.rejects(settle(), /still has time to say it never came/, "the customer has their time first");
  await assert.rejects(
    dispatch(merchant, "write_decision", { Outcome: { order: stalled, outcome: { Delivered: { proof: actionHash(pickedUp) } }, beacon: await currentBeacon() } }),
    /time to claim has run/,
    "the network holds it too",
  );
  // The customer's app goes quiet -- as one modified never to say would --
  // so it never says the order didn't come.
  await customer.conductor.shutDown();
  const live = [merchant, first, second];
  const liveSync = () => dhtSync(live, merchant.cells[0].cell_id[0]);
  await sleepUntil(settlesAt);
  await retryUntilOk(settle);
  await liveSync();
  /// What the customer was charged on `order`, as the store reads it.
  const customerNet = async (order: Uint8Array) => -(await paymentsOn(merchant, order)).filter((p) => bytesEqual(p.payer, customer.agentPubKey)).reduce((sum, p) => sum + (p.charged ?? 0), 0);
  const nets = await retryUntil(
    async () => {
      for (const p of live) {
        await call(p, "dispatch")("settle_order", stalled).catch(() => 0);
        await payeeAgent(p).catch(() => 0);
      }
      await liveSync();
      return [await customerNet(stalled), await netOn(second, stalled), await netOn(merchant, stalled)];
    },
    ([paid, driven]) => paid !== 0 && driven !== 0,
    120,
    1000,
  );
  assert.deepEqual(nets, [-(FOOD + FEE / 2), FEE, FOOD - FEE / 2], "the customer pays as for any delivery; the driver is paid for the drive; the store for the food, less its share of the fee");
  console.log("[PASS] a delivery picked up that nobody says more of is settled as delivered once the customer's time has run, and never before");
});

/// A delivery version's status.
function statusOf(record: HcRecord): string {
  return decodeEntry<{ status: string }>(record).status;
}
