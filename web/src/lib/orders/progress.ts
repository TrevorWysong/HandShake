// Where an order stands, as the steps a person cares about and a sentence to
// lead with -- what the active-order card and each order's hero draw. Pure,
// and every status is named, so a new one can't be left out of it.
import type { DeliveryStatus, PickupStatus } from "../../holochain/types";
import type { MessageKey } from "../../i18n";
import type { OrderRow } from "./orderEntries";

/// `moving`: on its way, nothing to do. `needsYou`: stuck until its person
/// acts. `arrived`: done well. `stopped`: won't go further. `quiet`: not
/// started, nothing to watch yet.
export type OrderTone = "moving" | "needsYou" | "arrived" | "stopped" | "quiet";

export interface OrderProgress {
  /// How many steps the path has, and how many are done: the current step
  /// is the next one.
  steps: number;
  done: number;
  headline: MessageKey;
  tone: OrderTone;
}

/// Something only the customer can move an order past, beyond its status.
export type OrderNeed = "pay" | "chooseDriver";

/// A delivery: the store answers, a driver takes it, the kitchen makes it, it
/// comes. The kitchen starts once a driver has committed.
const DELIVERY_STEPS = 4;
/// Collected instead of delivered: the store answered, the customer goes, has it.
const COLLECT_STEPS = 3;
/// A pickup: the store answers, makes it, the customer collects it.
const PICKUP_STEPS = 3;

function deliveryProgress(status: DeliveryStatus): OrderProgress {
  const on = (done: number, headline: MessageKey, tone: OrderTone = "moving") => ({ steps: DELIVERY_STEPS, done, headline, tone });
  switch (status) {
    case "Scheduled":
      return on(0, "progress.scheduled", "quiet");
    case "Placed":
      return on(0, "progress.waitingOnStore");
    case "Open":
      return on(1, "progress.findingDriver");
    case "BidAccepted":
      return on(1, "progress.driverFound");
    case "DriverEnRouteToMerchant":
      return on(2, "progress.driverToStore");
    case "MerchantConfirmed":
      return on(2, "progress.preparing");
    case "DriverAtStore":
      return on(3, "progress.driverAtStore");
    case "PickedUp":
      return on(3, "progress.onTheWay");
    case "Delivered":
      return on(4, "progress.delivered", "arrived");
    case "Unanswered":
      return on(3, "progress.unanswered", "needsYou");
    case "Disputed":
      return on(3, "progress.disputed", "needsYou");
    case "Cancelled":
      return on(0, "progress.cancelled", "stopped");
    case "Collecting":
      return { steps: COLLECT_STEPS, done: 1, headline: "progress.collecting", tone: "needsYou" };
    case "Collected":
      return { steps: COLLECT_STEPS, done: 3, headline: "progress.collected", tone: "arrived" };
  }
}

function pickupProgress(status: PickupStatus): OrderProgress {
  const on = (done: number, headline: MessageKey, tone: OrderTone = "moving") => ({ steps: PICKUP_STEPS, done, headline, tone });
  switch (status) {
    case "Placed":
      return on(0, "progress.waitingOnStore");
    case "MerchantConfirmed":
      return on(1, "progress.preparing");
    case "ReadyForPickup":
      return on(2, "progress.readyForPickup", "needsYou");
    case "PickedUp":
      return on(3, "progress.pickedUp", "arrived");
    case "Disputed":
      return on(2, "progress.disputed", "needsYou");
    case "Cancelled":
      return on(0, "progress.cancelled", "stopped");
  }
}

/// How an order stands for its customer -- what it needs of them first.
export function customerProgress(row: Pick<OrderRow, "kind" | "order">, need: OrderNeed | null = null): OrderProgress {
  const progress = row.kind === "Delivery" ? deliveryProgress(row.order.status as DeliveryStatus) : pickupProgress(row.order.status as PickupStatus);
  if (need === "pay") return { ...progress, headline: "progress.needsPayment", tone: "needsYou" };
  if (need === "chooseDriver") return { ...progress, headline: "progress.chooseDriver", tone: "needsYou" };
  return progress;
}

/// How a delivery stands for its driver: what to do next.
export function driverProgress(status: DeliveryStatus): OrderProgress {
  const on = (done: number, headline: MessageKey, tone: OrderTone = "moving") => ({ steps: 3, done, headline, tone });
  switch (status) {
    case "BidAccepted":
      return on(0, "progress.driver.commit", "needsYou");
    case "DriverEnRouteToMerchant":
    case "MerchantConfirmed":
      return on(1, "progress.driver.toStore");
    case "DriverAtStore":
      return on(1, "progress.driver.atStore");
    case "PickedUp":
      return on(2, "progress.driver.toCustomer");
    case "Unanswered":
      return on(2, "progress.driver.unanswered", "needsYou");
    case "Delivered":
    case "Collected":
      return on(3, "progress.delivered", "arrived");
    case "Disputed":
      return on(2, "progress.driver.disputed", "needsYou");
    case "Cancelled":
    case "Collecting":
      return on(0, "progress.cancelled", "stopped");
    case "Scheduled":
    case "Placed":
    case "Open":
      return on(0, "progress.findingDriver", "quiet");
  }
}

/// How an order stands for its store, while it's the store's to work on.
export function storeProgress(row: Pick<OrderRow, "kind" | "order">): OrderProgress {
  const on = (done: number, headline: MessageKey, tone: OrderTone = "moving") => ({ steps: 3, done, headline, tone });
  if (row.kind === "Pickup") {
    switch (row.order.status as PickupStatus) {
      case "Placed":
        return on(0, "progress.store.answer", "needsYou");
      case "MerchantConfirmed":
        return on(1, "progress.store.cooking");
      case "ReadyForPickup":
        return on(2, "progress.store.awaitingCustomer");
      case "PickedUp":
        return on(3, "progress.pickedUp", "arrived");
      case "Disputed":
        return on(2, "progress.store.disputed", "needsYou");
      case "Cancelled":
        return on(0, "progress.cancelled", "stopped");
    }
  }
  switch (row.order.status as DeliveryStatus) {
    case "Placed":
      return on(0, "progress.store.answer", "needsYou");
    case "Scheduled":
      return on(0, "progress.scheduled", "quiet");
    case "Open":
    case "BidAccepted":
      return on(1, "progress.store.awaitingDriver");
    case "DriverEnRouteToMerchant":
      return on(1, "progress.store.startCooking", "needsYou");
    case "MerchantConfirmed":
      return on(2, "progress.store.cooking");
    case "DriverAtStore":
      return on(2, "progress.store.driverHere", "needsYou");
    case "Collecting":
      return on(2, "progress.store.customerComing");
    case "PickedUp":
    case "Unanswered":
      return on(3, "progress.onTheWay");
    case "Delivered":
    case "Collected":
      return on(3, "progress.delivered", "arrived");
    case "Disputed":
      return on(3, "progress.store.disputed", "needsYou");
    case "Cancelled":
      return on(0, "progress.cancelled", "stopped");
  }
}

/// When an order's next moment should come, from what the network was told:
/// `arriving`, the driver's own estimate when they bid; `ready`, the store's.
/// In microseconds. Nothing to go on, or a time already past, is no estimate:
/// better none than one that's wrong.
export interface OrderEstimate {
  kind: "arriving" | "ready";
  at: number;
}

const ARRIVING: readonly string[] = ["DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore", "PickedUp"];

export function orderEstimate(row: Pick<OrderRow, "kind" | "order">, driverDueAt: number | null, nowMicros: number): OrderEstimate | null {
  if (row.kind === "Delivery" && ARRIVING.includes(row.order.status) && driverDueAt !== null && driverDueAt > nowMicros) return { kind: "arriving", at: driverDueAt };
  const cooking = row.kind === "Delivery" ? ["DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore"].includes(row.order.status) : row.order.status === "MerchantConfirmed";
  const readyBy = row.order.ready_by;
  if (cooking && readyBy !== null && readyBy > nowMicros) return { kind: "ready", at: readyBy };
  return null;
}
