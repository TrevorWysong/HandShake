// The world both conflicting-steps tests run in (conflicting-steps,
// conflicting-releases): late-orders' world, with each driver able to carry
// all of them and one customer placing many -- and the ways a test writes a
// step on an older version of an order, past the honest app's checks.
import assert from "node:assert/strict";
import type { Scenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, commitAndCook, currentBeacon, decodeEntry, retryUntil, retryUntilOk } from "./helpers.js";
import { FEE, lateOrderWorld, type PinSecret } from "./late-orders.world.js";

/// Seconds another driver has to take on an order its driver left cooking.
export const REPLACEMENT = 20;
export const BY_STORE = { ByStore: "OutdatedPrices" };

export async function conflictingWorld(scenario: Scenario) {
  const world = await lateOrderWorld(scenario, {
    replacement_window_secs: REPLACEMENT,
    max_concurrent_deliveries: 10,
    // One customer places several orders in a few minutes.
    max_pending_orders: 20,
  });
  const { customer, merchant, all, call, sync } = world;
  const dispatch = <T = unknown>(p: typeof customer, fn_name: string, payload: unknown) => p.cells[0].callZome<T>({ zome_name: "dispatch", fn_name, payload });
  /// `p` updating one exact version of an order, past every check the app
  /// makes.
  const branch = (p: typeof customer, version: Uint8Array, next_status: string, extra: Record<string, unknown> = {}) =>
    dispatch<Uint8Array>(p, "branch_order_for_testing", { version, next_status, ...extra });
  const leaving = async () => ({ release: true, beacon: await currentBeacon() });
  const endingForNoDriver = async () => ({ cancellation: "NoDriver", beacon: await currentBeacon() });
  /// The order's latest version once it's reached `status`.
  const versionAt = async (order: Uint8Array, status: string) => {
    const record = await retryUntil(() => dispatch<HcRecord>(merchant, "get_order", order), (r) => decodeEntry<{ status: string }>(r).status === status, 60, 1000);
    assert.equal(decodeEntry<{ status: string }>(record).status, status, `the order reaches ${status}`);
    return actionHash(record);
  };
  /// The store checking `driver` in on their code; the version that records
  /// it, and the one it updated.
  async function checkedIn(order: Uint8Array, driver: typeof customer) {
    const code = await call(merchant, "dispatch")<PinSecret>("get_my_pickup_code", order);
    await retryUntilOk(() => call(driver, "attestation")("check_in_at_store", { order_ref: order, code: code.pin }));
    await sync();
    const record = await retryUntil(() => dispatch<HcRecord>(merchant, "get_order", order), (r) => decodeEntry<{ status: string }>(r).status === "DriverAtStore", 60, 1000);
    const before = (record.signed_action.hashed.content.data as { original_action_address: Uint8Array }).original_action_address;
    return [actionHash(record), before] as const;
  }
  /// `customer`'s accepting `driver`'s bid on `order`, and the driver
  /// committing, the store cooking.
  async function takenOnBy(order: Uint8Array, driver: typeof customer) {
    const bid = actionHash(await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, to_store_seconds: 0, price_offer: FEE })));
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: bid }));
    await sync();
    await commitAndCook(driver, merchant, order, all);
  }

  return { ...world, dispatch, branch, leaving, endingForNoDriver, versionAt, checkedIn, takenOnBy };
}
