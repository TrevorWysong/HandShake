// Two parties acting on the same version of an order at once -- each step
// valid on its own, the pair never both. An order's history can branch, and
// Holochain can't say which branch came first, so validation decides each
// such pair on one author's own chain (`dispatch_types::lineage`). Each
// refusal here is written past the honest app's checks, on an older version
// -- what a modified app, or two apps racing, could do. Orders a driver left
// cooking (the drivers at the counter are conflicting-releases):
//
// - a store that's confirmed another driver can't also end the order for
//   want of one; one that's ended it so can't then have it collected; one
//   that's called it off can't also end it for want of a driver; one that
//   checked a driver in can't make them answer for the food on a branch
//   where they left.
//
// The store's own app tends its orders all the while (it cooks, moves late
// drivers on, ends orders no driver came for), as it would for real: every
// write here is one it would never make. The world, and how a step is
// written on an older version, are in conflicting-steps.world.ts.
import assert from "node:assert/strict";
import { runScenario } from "@holochain-open-dev/tryorama";
import { currentBeacon, deliveryStatus, retryUntil, retryUntilOk } from "./helpers.js";
import { sleepUntil } from "./late-orders.world.js";
import { conflictingWorld, BY_STORE, REPLACEMENT } from "./conflicting-steps.world.js";

await runScenario(async (scenario) => {
  const { customer, merchant, first, second, call, sync, placed, driving, drop, branch, leaving, endingForNoDriver, versionAt, checkedIn, takenOnBy } = await conflictingWorld(scenario);

  // ===== Orders a driver left cooking, each with a step on another branch =====
  // Confirmed another driver: the second driver takes it on after the first
  // leaves, and the store cooks for them.
  const replaced = await placed();
  await driving(replaced, first);
  await drop(replaced, first);
  const replacedLeft = await versionAt(replaced, "Open");
  await takenOnBy(replaced, second);
  // Ended for want of a driver: nobody takes it on.
  const abandoned = await placed();
  await driving(abandoned, first);
  await drop(abandoned, first);
  const abandonedLeft = await versionAt(abandoned, "Open");
  // Called off by the store, after its driver left.
  const calledOff = await placed();
  await driving(calledOff, first);
  await drop(calledOff, first);
  const calledOffLeft = await versionAt(calledOff, "Open");
  // The store calling it off, as its app would (keeping the time its driver
  // left, which a call-off doesn't change).
  await retryUntilOk(() => branch(merchant, calledOffLeft, "Cancelled", { cancellation: BY_STORE }));
  await sync();
  // Checked in on one branch; on another, its driver leaves before it.
  const atCounter = await placed();
  await driving(atCounter, second);
  const [, atCounterCooking] = await checkedIn(atCounter, second);
  const atCounterLeft = await branch(second, atCounterCooking, "Open", await leaving());
  await sync();

  await sleepUntil((Date.now() + REPLACEMENT * 1000) * 1000);

  await assert.rejects(branch(merchant, replacedLeft, "Cancelled", await endingForNoDriver()), /confirmed another driver for this order/);
  console.log("[PASS] a store that's confirmed another driver can't also end the order for want of one");

  // The store's app ends it, as this does if it hasn't yet.
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("end_for_no_driver", { order_ref: abandoned, beacon: await currentBeacon() }).catch(() => null);
      return deliveryStatus(customer, abandoned);
    },
    (s) => s === "Cancelled",
    60,
    1000,
  );
  await sync();
  await assert.rejects(branch(merchant, abandonedLeft, "Collecting"), /ended an order for want of a driver can't confirm another/);
  console.log("[PASS] a store that's ended an order for want of a driver can't also have it collected");

  await assert.rejects(branch(merchant, calledOffLeft, "Cancelled", await endingForNoDriver()), /already ended this order another way/);
  console.log("[PASS] a store that's called an order off can't also end it on its driver's account");

  await assert.rejects(branch(merchant, atCounterLeft, "Cancelled", await endingForNoDriver()), /checked that driver in, so they don't answer for the food/);
  console.log("[PASS] a driver the store checked in never answers for the food, on any branch");
});
