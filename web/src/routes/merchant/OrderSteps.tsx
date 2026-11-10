// What a store does with an order on its Orders screen (Orders.tsx):
// accepting or declining it, answering a customer who can't get it, and
// each step after -- checking its driver in, handing it over.
import { useState } from "react";
import clsx from "clsx";
import {
  acceptDeliveryOrder,
  acceptPickupOrder,
  declineOrder,
  declinePickupOrder,
  dismissPickupProblem,
  markReadyForPickup,
  setOrderStatus,
} from "../../holochain/zomes/dispatch";
import { type QueueRow } from "../../store/merchantQueue";
import { DECLINE_REASONS, declineLabel, responseDeadlineMs } from "../../lib/orders/storeAnswers";
import { useTerms } from "../../store/network";
import { ResponseCountdown } from "../../components/orders/ResponseCountdown";
import { Button } from "../../components/ui";
import { OrderPayments } from "../../components/payments/OrderPayments";
import { formatDeadline, formatEta } from "../../lib/ui/format";
import type { DeclineReason } from "../../holochain/types";
import { useT } from "../../i18n";
import { CollectionHandoff, NeverArrivedClaim, NeverCameForPickup, PickupHandoff } from "./OrderHandoffs";

/// The prep times a kitchen picks from when it accepts an order (within
/// the network's longest), alongside the store's own usual time.
const PREP_CHOICES = [5, 10, 15, 20, 30, 45, 60, 90, 120];

/// A step taken on an order, by its original action.
export type OrderAction = (ref: Uint8Array) => Promise<unknown>;

/// A customer saying they can't get their pickup: the store decides. Declining
/// says it's ready, and they pay if they don't collect it; accepting cancels with
/// no charge -- asked once more, since it can't be undone and the store goes unpaid.
function CantGetAnswer({ answerBy, windowSecs, busy, onDecline, onAccept }: { answerBy: number; windowSecs: number; busy: boolean; onDecline: () => void; onAccept: () => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="mt-3 rounded-xl bg-amber-50 p-3 dark:bg-amber-900/20">
      <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-100">{t("merchantOrders.cantGet", { minutes: Math.round(windowSecs / 60), time: formatDeadline(answerBy) })}</p>
      {confirming ? (
        <>
          <p className="mt-2 text-xs font-semibold leading-relaxed text-amber-900 dark:text-amber-100">{t("merchantOrders.cancelNoChargeConfirm")}</p>
          <div className="mt-2 flex gap-2">
            <Button variant="ghost" className="flex-1 py-2 text-xs" disabled={busy} onClick={() => setConfirming(false)}>{t("common.back")}</Button>
            <Button variant="danger" className="flex-1 py-2 text-xs" loading={busy} onClick={onAccept}>{t("merchantOrders.cancelNoCharge")}</Button>
          </div>
        </>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button variant="ghost" className="flex-1 py-2 text-xs" disabled={busy} onClick={() => setConfirming(true)}>{t("merchantOrders.cancelNoCharge")}</Button>
          <Button className="flex-1 py-2 text-xs" loading={busy} onClick={onDecline}>{t("merchantOrders.cantGetReady")}</Button>
        </div>
      )}
    </div>
  );
}

/// A new order, waiting on the store: Accept -- the store's check that it's
/// priced from the current menu (the zome refuses it otherwise) and, for a
/// delivery, what puts it in front of drivers -- or Decline, with a reason
/// the customer is told. Past the window it can't be accepted; the
/// customer's conductor cancels it.
export function AnswerOrder({ row, windowSecs, now, defaultPrep, busy, onAdvance }: { row: QueueRow; windowSecs: number; now: number; defaultPrep: number; busy: boolean; onAdvance: (action: OrderAction) => void }) {
  const [choosingReason, setChoosingReason] = useState(false);
  const t = useT();
  // How long this one will take -- the store's usual time unless the
  // kitchen picks another; the customer is told when it'll be ready.
  const [prep, setPrep] = useState(defaultPrep);
  const maxPrep = useTerms().max_prep_minutes;
  const prepChoices = [...new Set([defaultPrep, ...PREP_CHOICES])].filter((m) => m <= maxPrep).sort((a, b) => a - b);
  const deadlineMs = responseDeadlineMs(row.writtenAt, windowSecs);
  if (now >= deadlineMs) {
    return <p className="mt-2 text-xs text-ink-400">{t("merchantOrders.tooLate")}</p>;
  }
  const accept: OrderAction = row.kind === "Delivery" ? (ref) => acceptDeliveryOrder(ref, prep) : (ref) => acceptPickupOrder(ref, prep);
  const decline = (reason: DeclineReason): OrderAction =>
    row.kind === "Delivery" ? (ref) => declineOrder(ref, reason) : (ref) => declinePickupOrder(ref, reason);
  return (
    <>
      <ResponseCountdown deadlineMs={deadlineMs} windowSecs={windowSecs} now={now} label="merchantOrders.acceptBy" />
      {choosingReason ? (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-semibold text-ink-500">{t("merchantOrders.whyDecline")}</p>
          <div className="flex flex-wrap gap-1.5">
            {DECLINE_REASONS.map((reason) => (
              <Button key={reason} variant="ghost" className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => onAdvance(decline(reason))}>
                {declineLabel(reason)}
              </Button>
            ))}
            <Button variant="ghost" className="px-3 py-1.5 text-xs text-ink-400" disabled={busy} onClick={() => setChoosingReason(false)}>
              {t("common.back")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-1.5 overflow-x-auto no-scrollbar" role="radiogroup" aria-label={t("merchantOrders.readyIn")}>
            <span className="shrink-0 text-[11px] font-semibold text-ink-500">{t("merchantOrders.readyIn")}</span>
            {prepChoices.map((minutes) => (
              <button
                key={minutes}
                role="radio"
                aria-checked={prep === minutes}
                onClick={() => setPrep(minutes)}
                className={clsx(
                  "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition",
                  prep === minutes ? "bg-ink-900 text-white dark:bg-white dark:text-ink-900" : "bg-ink-100 text-ink-500 dark:bg-ink-800",
                )}
              >
                {formatEta(minutes * 60)}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Button variant="ghost" className="flex-1 py-2 text-xs" disabled={busy} onClick={() => setChoosingReason(true)}>
              {t("issues.decline")}
            </Button>
            <Button className="flex-[2] py-2 text-xs" loading={busy} onClick={() => onAdvance(accept)}>
              {t("order.accept")} · {formatEta(prep * 60)}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/// What the merchant can do next for an order they've accepted, or what
/// they're waiting on.
/// A delivery's driver, until they've picked it up: the store pays them on
/// its card.
const PAYING_DRIVER = ["BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore"];

export function ActiveActions(props: { row: QueueRow; busy: boolean; onAdvance: (action: OrderAction) => void }) {
  const { row } = props;
  return (
    <>
      {row.kind === "Delivery" && PAYING_DRIVER.includes(row.order.status) && (
        <div className="mt-3">
          <OrderPayments order={row.ref} delivery compact />
        </div>
      )}
      <ActiveSteps {...props} />
    </>
  );
}

function ActiveSteps({ row, busy, onAdvance }: { row: QueueRow; busy: boolean; onAdvance: (action: OrderAction) => void }) {
  const terms = useTerms();
  const minAge = terms.restricted_min_age;
  const t = useT();
  const button = (label: string, action: OrderAction) => (
    <Button className="mt-3 w-full py-2 text-xs" loading={busy} onClick={() => onAdvance(action)}>
      {label}
    </Button>
  );
  const note = (text: string) => <p className="mt-2 text-xs text-ink-400">{text}</p>;
  if (row.kind === "Delivery") {
    switch (row.order.status) {
      case "Open":
        return note(t("merchantOrders.findingDriver"));
      case "BidAccepted":
        return note(t("merchantOrders.driverFound"));
      case "DriverEnRouteToMerchant":
        return (
          <>
            {note(t("merchantOrders.driverOnWay"))}
            {button(t("merchantOrders.startCooking"), (ref) => setOrderStatus(ref, "MerchantConfirmed"))}
          </>
        );
      case "Scheduled":
        return note(t("merchantOrders.scheduled"));
      case "MerchantConfirmed":
        return <PickupHandoff orderHex={row.hex} orderRef={row.ref} checkedIn={false} />;
      case "DriverAtStore":
        return <PickupHandoff orderHex={row.hex} orderRef={row.ref} checkedIn />;
      case "PickedUp":
        return note(t("merchantOrders.outForDelivery"));
      case "Unanswered":
      case "Disputed":
        return <NeverArrivedClaim orderHex={row.hex} orderRef={row.ref} disputed={row.order.status === "Disputed"} />;
      case "Collecting":
        return <CollectionHandoff row={row} />;
      default:
        return null;
    }
  }
  switch (row.order.status) {
    case "MerchantConfirmed":
      return button(t("merchantOrders.markReady"), markReadyForPickup);
    case "ReadyForPickup":
      // The customer confirmed their age when ordering; the store checks
      // it, in person, at the counter.
      return (
        <>
          {note("age_confirmed" in row.order && row.order.age_confirmed ? t("merchantOrders.waitingCollectId", { age: minAge ?? 18 }) : t("merchantOrders.waitingCollect"))}
          <NeverCameForPickup row={row} />
        </>
      );
    case "Disputed":
      return <CantGetAnswer answerBy={row.writtenAt + terms.answer_grace_secs * 1_000_000} windowSecs={terms.collection_window_secs} busy={busy} onDecline={() => onAdvance(dismissPickupProblem)} onAccept={() => onAdvance((ref) => declinePickupOrder(ref, "Other"))} />;
    default:
      return null;
  }
}
