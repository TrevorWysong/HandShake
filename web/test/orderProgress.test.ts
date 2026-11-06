import assert from "node:assert/strict";
import { test } from "node:test";
import { customerProgress, driverProgress, orderEstimate, storeProgress } from "../src/lib/orders/progress.ts";
import { isFinished, leftTheStore, type OrderRow } from "../src/lib/orders/orderEntries.ts";
import type { DeliveryOrder, DeliveryStatus, PickupOrder, PickupStatus } from "../src/holochain/types.ts";

const delivery = (status: DeliveryStatus, ready_by: number | null = null) => ({ kind: "Delivery", order: { status, ready_by } as DeliveryOrder }) as OrderRow;
const pickup = (status: PickupStatus, ready_by: number | null = null) => ({ kind: "Pickup", order: { status, ready_by } as PickupOrder }) as OrderRow;

const DELIVERY: DeliveryStatus[] = ["Placed", "Open", "BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore", "PickedUp", "Delivered"];

test("a delivery only ever moves forward along its path", () => {
  const done = DELIVERY.map((status) => customerProgress(delivery(status)).done);
  assert.deepEqual(done, [...done].sort((a, b) => a - b));
  assert.equal(customerProgress(delivery("Delivered")).done, customerProgress(delivery("Delivered")).steps);
});

test("what needs the customer says so, and what's going doesn't", () => {
  assert.equal(customerProgress(delivery("Placed")).tone, "moving");
  assert.equal(customerProgress(delivery("Placed"), "pay").tone, "needsYou");
  assert.equal(customerProgress(delivery("Placed"), "pay").headline, "progress.needsPayment");
  assert.equal(customerProgress(delivery("Open"), "chooseDriver").headline, "progress.chooseDriver");
  assert.equal(customerProgress(delivery("Unanswered")).tone, "needsYou");
  assert.equal(customerProgress(delivery("Collecting")).tone, "needsYou");
  assert.equal(customerProgress(pickup("ReadyForPickup")).tone, "needsYou");
  assert.equal(customerProgress(delivery("Cancelled")).tone, "stopped");
  assert.equal(customerProgress(pickup("Cancelled")).tone, "stopped");
});

test("drivers and stores each read what's theirs to do next", () => {
  assert.equal(driverProgress("BidAccepted").tone, "needsYou");
  assert.equal(driverProgress("PickedUp").headline, "progress.driver.toCustomer");
  assert.equal(storeProgress(delivery("Placed")).headline, "progress.store.answer");
  assert.equal(storeProgress(delivery("DriverEnRouteToMerchant")).headline, "progress.store.startCooking");
  assert.equal(storeProgress(pickup("MerchantConfirmed")).headline, "progress.store.cooking");
});

test("a delivery on its way isn't finished, though the store's done with it", () => {
  assert.equal(isFinished(delivery("PickedUp")), false);
  assert.equal(leftTheStore(delivery("PickedUp")), true);
  assert.equal(isFinished(pickup("PickedUp")), true);
  for (const status of ["Delivered", "Collected", "Cancelled"] as const) assert.equal(isFinished(delivery(status)), true);
  assert.equal(isFinished(delivery("Unanswered")), false);
  assert.equal(isFinished(delivery("Disputed")), false);
});

test("an estimate is only what someone said, and only while it's ahead", () => {
  const NOW = 1_000;
  assert.deepEqual(orderEstimate(delivery("PickedUp"), 2_000, NOW), { kind: "arriving", at: 2_000 });
  assert.equal(orderEstimate(delivery("PickedUp"), 500, NOW), null, "a time gone by is no estimate");
  assert.equal(orderEstimate(delivery("PickedUp"), null, NOW), null, "nothing to go on, nothing shown");
  assert.equal(orderEstimate(delivery("Open"), 2_000, NOW), null, "a driver's not on it yet");
  assert.deepEqual(orderEstimate(delivery("MerchantConfirmed", 3_000), null, NOW), { kind: "ready", at: 3_000 });
  assert.deepEqual(orderEstimate(pickup("MerchantConfirmed", 3_000), null, NOW), { kind: "ready", at: 3_000 });
  assert.equal(orderEstimate(pickup("ReadyForPickup", 3_000), null, NOW), null);
});
