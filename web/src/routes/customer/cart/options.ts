// The choices checkout offers: tips, how a delivery is handed over, how
// it's driven, and who picks its driver.
import type { MessageKey } from "../../../i18n";
import type { DropoffPreference } from "../../../holochain/types";

export const TIP_PRESETS_PERCENT = [0, 10, 15, 20];
export const DROPOFF_PREFERENCE_OPTIONS: readonly { value: DropoffPreference; label: MessageKey }[] = [
  { value: "HandToMe", label: "cart.drop.handToMe" },
  { value: "MeetOutside", label: "cart.drop.meetOutside" },
  { value: "LeaveAtDoor", label: "cart.drop.leaveAtDoor" },
] as const;
/// How a delivery is driven: standard, or priority -- a driver with no
/// other orders (`DeliveryOrder::priority`).
export const DELIVERY_SPEEDS = [
  { priority: false, label: "cart.speed.standard", detail: "cart.speed.standardDetail" },
  { priority: true, label: "cart.speed.priority", detail: "cart.speed.priorityDetail" },
] as const;

/// Who picks the driver: the app, by the network's published rule, or the
/// customer.
export const MATCHING = [
  { autoMatch: true, label: "cart.match.auto", detail: "cart.match.autoDetail" },
  { autoMatch: false, label: "cart.match.manual", detail: "cart.match.manualDetail" },
] as const;
