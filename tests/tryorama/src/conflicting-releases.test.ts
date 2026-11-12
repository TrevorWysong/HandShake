// Two parties acting on the same version of an order at once, for drivers
// due at the store's counter (the orders a driver left cooking are
// conflicting-steps). Each refusal is written past the honest app's checks,
// on an older version:
//
// - a store can't move on a driver it's checked in, nor check in one it's
//   moved on;
// - a driver who's picked an order up can't also leave it;
// - a driver who leaves while the store moves them on is charged for the
//   food once, not twice, and the store is paid for it once;
// - a delivery completed twice at once -- by its driver, and by its
//   customer on the same version -- pays each party once and counts once
//   on the driver's record.
//
// The store's own app tends its orders all the while (it cooks, moves late
// drivers on, ends orders no driver came for), as it would for real: every
// write here is one it would never make. The world, and how a step is
// written on an older version, are in conflicting-steps.world.ts.
import assert from "node:assert/strict";
import { runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { bytesEqual, collectFromStore, currentBeacon, decodeEntry, deliveryStatus, handOff, paymentsOn, retryUntil, retryUntilOk } from "./helpers.js";
import { FEE, FOOD, sleepUntil } from "./late-orders.world.js";
import { conflictingWorld, REPLACEMENT } from "./conflicting-steps.world.js";

await runScenario(async (scenario) => {
  const { customer, merchant, first, second, all, call, sync, placed, driving, settlesTo, timing, branch, leaving, versionAt, checkedIn } = await conflictingWorld(scenario);

  // ===== Drivers due at the counter =====
  // Checked in, and then -- on the version before -- moved on as late.
  const checked = await placed();
  await driving(checked, first);
  const checkedDue = (await timing(checked)).driver_due;
  const [, checkedCooking] = await checkedIn(checked, first);
  // Moved on as late, and then -- on the version before -- checked in.
  const movedOn = await placed();
  await driving(movedOn, second);
  const movedOnCooking = await versionAt(movedOn, "MerchantConfirmed");
  const movedOnDue = (await timing(movedOn)).driver_due;
  // Left by its driver while, on the same version, the store moves them on.
  const twice = await placed();
  await driving(twice, first);
  const twiceCooking = await versionAt(twice, "MerchantConfirmed");
  const twiceDue = (await timing(twice)).driver_due;
  await branch(first, twiceCooking, "Open", await leaving());
  await sync();
  // The same two releases the other way round: the store's lands first.
  const twiceBack = await placed();
  await driving(twiceBack, second);
  const twiceBackCooking = await versionAt(twiceBack, "MerchantConfirmed");
  const twiceBackDue = (await timing(twiceBack)).driver_due;
  // Picked up, and then -- on the version at the counter -- left.
  const carried = await placed();
  await driving(carried, second);
  const [carriedAtCounter] = await checkedIn(carried, second);
  await collectFromStore(second, merchant, carried, all);
  await versionAt(carried, "PickedUp");
  await assert.rejects(branch(second, carriedAtCounter, "Open", await leaving()), /either leaves an order or picks it up/);
  console.log("[PASS] a driver who's picked an order up can't also leave it, on any branch");

  assert.ok(checkedDue && movedOnDue && twiceDue && twiceBackDue, "each driver is due at the store");
  await sleepUntil(Math.max(checkedDue, movedOnDue, twiceDue, twiceBackDue));

  await assert.rejects(branch(merchant, checkedCooking, "Open", await leaving()), /can't move on a driver it's checked in/);
  console.log("[PASS] a store can't move on a driver it's checked in, on any branch");

  // The store's app moves the late driver on, as this does if it hasn't yet.
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("move_driver_on", { order_ref: movedOn, beacon: await currentBeacon() }).catch(() => null);
      return deliveryStatus(customer, movedOn);
    },
    (s) => s !== "MerchantConfirmed",
    60,
    1000,
  );
  await sync();
  await assert.rejects(branch(merchant, movedOnCooking, "DriverAtStore"), /can't check in a driver it's moved on/);
  console.log("[PASS] a store can't check in a driver it's moved on, on any branch");

  // ===== One driver released twice at once, in either order =====
  // The driver left first on `twice`; here the store moves them on too. On
  // `twiceBack` the store moves them on first, and they leave after.
  await retryUntilOk(async () => branch(merchant, twiceCooking, "Open", await leaving()));
  await retryUntilOk(async () => branch(merchant, twiceBackCooking, "Open", await leaving()));
  await sync();
  await retryUntilOk(async () => branch(second, twiceBackCooking, "Open", await leaving()));
  await sync();
  await sleepUntil((Date.now() + REPLACEMENT * 1000) * 1000);
  for (const [order, driver, which] of [[twice, first, "driver first"], [twiceBack, second, "store first"]] as const) {
    await retryUntil(
      async () => {
        await call(merchant, "dispatch")("end_for_no_driver", { order_ref: order, beacon: await currentBeacon() }).catch(() => null);
        return deliveryStatus(customer, order);
      },
      (s) => s === "Cancelled",
      60,
      1000,
    );
    await sync();
    await settlesTo(customer, order, 0, `${which}: the customer is refunded in full`);
    await settlesTo(merchant, order, FOOD, `${which}: the store is paid for the food once`);
    await settlesTo(driver, order, -FOOD, `${which}: the driver pays for it once, not for each release`);
    for (const p of await paymentsOn(merchant, order)) {
      assert.ok((p.charged ?? 0) <= p.held, `${which}: no hold is charged past what it held`);
    }
    const collateral = (await paymentsOn(merchant, order)).filter((p) => bytesEqual(p.payer, driver.agentPubKey) && (p.charged ?? 0) > 0);
    assert.equal(collateral.length, 1, `${which}: one charge to the driver, however many branches released them`);
  }
  console.log("[PASS] a driver who leaves while the store moves them on pays for the food once, whichever release lands first");

  // ===== One delivery completed twice at once =====
  const done = await placed();
  await driving(done, first);
  await collectFromStore(first, merchant, done, all);
  const pickedUp = await versionAt(done, "PickedUp");
  await handOff(first, customer, done, "CustomerHandoff", all);
  await retryUntilOk(() => call(first, "dispatch")("complete_delivery", { order_original_action: done }));
  await sync();
  const delivered = decodeEntry<{ delivery_receipts: Uint8Array[] }>(await retryUntil(() => call(merchant, "dispatch")<HcRecord>("get_order", done), (r) => decodeEntry<{ status: string }>(r).status === "Delivered", 60, 1000));
  // The customer confirms it too, on the version before -- as their app
  // could while the driver's completion was on its way.
  await retryUntilOk(() => branch(customer, pickedUp, "Delivered", { delivery_receipts: delivered.delivery_receipts }));
  await sync();
  await settlesTo(customer, done, -(FOOD + FEE / 2), "the customer pays once");
  await settlesTo(first, done, FEE, "the driver is paid once");
  await settlesTo(merchant, done, FOOD - FEE / 2, "and the store once");
  const record = await retryUntil(() => call(customer, "reputation")<{ completed_count: number }>("get_reputation_summary", { Driver: first.agentPubKey }), (s) => s.completed_count >= 1, 60, 1000);
  assert.equal(record.completed_count, 1, "and it counts once on the driver's record");
  console.log("[PASS] a delivery completed twice at once pays each party once and counts once");
});
