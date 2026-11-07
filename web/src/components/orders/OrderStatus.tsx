import { Check, ChefHat, CircleDot, PackageCheck, Bike, ShoppingBag, Store, XCircle, AlertTriangle, Clock, MapPin } from "lucide-react";
import { motion } from "framer-motion";
import clsx from "clsx";
import type { Cancellation, DeliveryStatus, PickupStatus } from "../../holochain/types";
import { cancellationText } from "../../lib/orders/storeAnswers";
import { Badge } from "../ui";
import { fadeSlideUp } from "../../lib/ui/motion";
import { useT, type MessageKey } from "../../i18n";

/// The kitchen starts once a driver has committed, so an order no driver
/// takes costs nobody anything.
const STEPS: { status: DeliveryStatus; label: MessageKey }[] = [
  { status: "Placed", label: "status.step.placed" },
  { status: "Open", label: "status.step.findingDriver" },
  { status: "BidAccepted", label: "status.step.driverFound" },
  { status: "DriverEnRouteToMerchant", label: "status.step.driverToStore" },
  { status: "MerchantConfirmed", label: "status.step.preparing" },
  { status: "DriverAtStore", label: "status.step.driverAtStore" },
  { status: "PickedUp", label: "status.step.pickedUp" },
  { status: "Delivered", label: "status.step.delivered" },
];

/// The path when no driver brought it and the customer collects it.
const COLLECT_STEPS: { status: DeliveryStatus; label: MessageKey }[] = [
  { status: "Placed", label: "status.step.placed" },
  { status: "Open", label: "status.step.storeAccepted" },
  { status: "Collecting", label: "status.step.collecting" },
  { status: "Collected", label: "status.step.collected" },
];

function statusTone(status: DeliveryStatus): "neutral" | "brand" | "success" | "warn" | "danger" {
  switch (status) {
    case "Delivered":
    case "Collected":
      return "success";
    case "Cancelled":
      return "neutral";
    case "Disputed":
      return "danger";
    case "Placed":
    case "Open":
      return "brand";
    case "Scheduled":
      return "neutral";
    default:
      return "warn";
  }
}

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  const t = useT();
  return <Badge tone={statusTone(status)}>{t(`status.delivery.${status}`)}</Badge>;
}

function TerminalBanner({ icon, tone, children }: { icon: React.ReactNode; tone: "neutral" | "danger"; children: React.ReactNode }) {
  const tones = {
    neutral: "bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-300",
    danger: "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300",
  };
  return (
    <motion.div initial="hidden" animate="visible" variants={fadeSlideUp} className={clsx("flex items-center gap-3 rounded-xl px-4 py-3", tones[tone])}>
      {icon}
      <span className="font-medium">{children}</span>
    </motion.div>
  );
}

/// A DoorDash/UberEats-style vertical progress tracker. Cancelled/Disputed
/// deliveries render as a terminal banner instead of a step position, since they don't
/// sit on the linear happy-path sequence. Each step's connecting line
/// "fills" with a quick top-down scale animation as it completes, instead
/// of just snapping to its done state -- the one place in this app where
/// *progress itself* (not just a list appearing) deserves motion.
/// A happy path's steps, those done and the current one lit -- the
/// timeline both order kinds draw.
function StepList({ labels, icons, current }: { labels: MessageKey[]; icons: (typeof Check)[]; current: number }) {
  const t = useT();
  return (
    <ol className="relative flex flex-col gap-0">
      {labels.map((label, i) => {
        const Icon = icons[i];
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex gap-3 pb-2 last:pb-0">
            <div className="flex flex-col items-center">
              <motion.div
                initial={false}
                animate={{ scale: done || active ? 1 : 0.92, opacity: done || active ? 1 : 0.7 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className={clsx(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                  done || active ? "bg-handshake-500 text-white shadow-[var(--shadow-glow)]" : "bg-ink-100 dark:bg-ink-800 text-ink-300 dark:text-ink-600",
                )}
              >
                <Icon size={14} />
              </motion.div>
              {i < labels.length - 1 && (
                <div className="relative mt-1 w-0.5 flex-1 overflow-hidden bg-ink-100 dark:bg-ink-800" style={{ minHeight: 12 }}>
                  <motion.div
                    className="absolute inset-x-0 top-0 bg-handshake-400"
                    initial={false}
                    animate={{ height: done ? "100%" : "0%" }}
                    transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              )}
            </div>
            <div className={clsx("pt-0.5 text-sm font-medium", done || active ? "text-ink-900 dark:text-ink-50" : "text-ink-400 dark:text-ink-600")}>
              {t(label)}
              {active && <span className="ml-2 inline-block h-2 w-2 rounded-full bg-presence-500 animate-pulse align-middle" />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function OrderStatusTimeline({ status, cancellation = null, viewer = "customer" }: { status: DeliveryStatus; cancellation?: Cancellation | null; viewer?: "customer" | "driver" }) {
  const t = useT();
  if (status === "Scheduled") {
    return (
      <TerminalBanner icon={<Clock size={20} />} tone="neutral">
        {t("status.scheduled")}
      </TerminalBanner>
    );
  }
  if (status === "Cancelled") {
    return (
      <TerminalBanner icon={<XCircle size={20} />} tone="neutral">
        {cancellationText(cancellation)}
      </TerminalBanner>
    );
  }
  if (status === "Disputed") {
    return (
      <TerminalBanner icon={<AlertTriangle size={20} />} tone="danger">
        {t(viewer === "customer" ? "status.disputed.customer" : "status.disputed.driver")}
      </TerminalBanner>
    );
  }
  if (status === "Unanswered") {
    return (
      <TerminalBanner icon={<AlertTriangle size={20} />} tone="danger">
        {t("status.unanswered")}
      </TerminalBanner>
    );
  }

  const collecting = status === "Collecting" || status === "Collected";
  const steps = collecting ? COLLECT_STEPS : STEPS;
  const currentIndex = steps.findIndex((s) => s.status === status);
  const icons = collecting ? [CircleDot, Store, ShoppingBag, Check] : [CircleDot, Store, Check, Bike, ChefHat, MapPin, PackageCheck, Check];

  return <StepList labels={steps.map((s) => s.label)} icons={icons} current={currentIndex} />;
}

const PICKUP_STEPS: { status: PickupStatus; label: MessageKey }[] = [
  { status: "Placed", label: "status.step.placed" },
  { status: "MerchantConfirmed", label: "status.step.acceptedPreparing" },
  { status: "ReadyForPickup", label: "status.step.ready" },
  { status: "PickedUp", label: "status.step.pickedUp" },
];

function pickupStatusTone(status: PickupStatus): "neutral" | "brand" | "success" | "warn" | "danger" {
  switch (status) {
    case "PickedUp":
      return "success";
    case "Cancelled":
      return "neutral";
    case "Disputed":
      return "danger";
    case "Placed":
      return "brand";
    default:
      return "warn";
  }
}

export function PickupStatusBadge({ status }: { status: PickupStatus }) {
  const t = useT();
  return <Badge tone={pickupStatusTone(status)}>{t(`status.pickup.${status}`)}</Badge>;
}

/// `OrderStatusTimeline`'s pickup sibling -- a separate, smaller `STEPS`
/// array rather than a conditional branch in the same component, since
/// `PickupStatus` and `DeliveryStatus` aren't the same type and the two
/// happy paths don't share a step count or meaning (see `PickupOrder`'s own
/// doc comment in `dispatch_integrity` for why this is a wholly separate
/// vertical).
export function PickupStatusTimeline({ status, cancellation = null }: { status: PickupStatus; cancellation?: Cancellation | null }) {
  if (status === "Cancelled") {
    return (
      <TerminalBanner icon={<XCircle size={20} />} tone="neutral">
        {cancellationText(cancellation)}
      </TerminalBanner>
    );
  }

  // A customer who can't get it is still at this step: it's ready, or the
  // store says so. Its page says what happens next.
  const currentIndex = PICKUP_STEPS.findIndex((s) => s.status === (status === "Disputed" ? "ReadyForPickup" : status));
  const icons = [CircleDot, ChefHat, ShoppingBag, Check];

  return <StepList labels={PICKUP_STEPS.map((s) => s.label)} icons={icons} current={currentIndex} />;
}
