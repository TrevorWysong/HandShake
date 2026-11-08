// What a store does with one order at its counter and after: handing it to
// its driver or its customer, recording one that was never collected,
// deciding one its customer says never arrived -- and what the kitchen
// must read first on its ticket. Each is a panel on the order's card in
// `Orders`.
import { useState } from "react";
import { decideNotDelivered, getMyPickupCode, getOrderDecisions, getOrderPrivateDetails, getOrderTiming, handOverCollection, markNotCollected, markPickupNotCollected } from "../../holochain/zomes/dispatch";
import { acknowledgeLeg } from "../../holochain/zomes/attestation";
import { HANDOFF_CODE_DIGITS } from "../../holochain/types";
import { QrScanner } from "../../components/QrScanner";
import { AllergyRequest } from "../../components/store/Allergens";
import { HandoverCode } from "../../components/orders/HandoverCode";
import { NoShowEvidence } from "../../components/orders/NoShowEvidence";
import { PinField } from "../../components/orders/PinField";
import { Button } from "../../components/ui";
import { decodeHandoverCode, decodePickupCode, pickupDigits } from "../../lib/orders/handoverCode";
import { unconfirmedPickup } from "../../lib/orders/handoffs";
import { currentBeacon, PROOF_MARGIN_MICROS } from "../../lib/network/timeSource";
import { POLL } from "../../lib/network/poll";
import { formatClockTime, formatDeadline } from "../../lib/ui/format";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";
import { useClock } from "../../lib/hooks/useClock";
import { useTerms } from "../../store/network";
import type { QueueRow } from "../../store/merchantQueue";
import { useT } from "../../i18n";

/// The driver at the counter: the store's check-in code for them to scan as
/// they arrive, then the store scanning *their* code as it hands the order
/// over -- or typing the digits under it, which match only the pickup this
/// order's driver recorded. Handing it over checks
/// them in too, if they hadn't. Checked in, the driver is owed their fee if
/// the store keeps them waiting past the network's wait.
export function PickupHandoff({ orderHex, orderRef, checkedIn }: { orderHex: string; orderRef: Uint8Array; checkedIn: boolean }) {
  const terms = useTerms();
  const [scanning, setScanning] = useState(false);
  const [typed, setTyped] = useState("");
  const t = useT();
  // A scanner reads a held-up code many times a second: one hand-over.
  const handing = useAction();
  const { data: code } = useResource(checkedIn ? null : `pickup-code:${orderHex}`, () => getMyPickupCode(orderRef));
  const { data: pickup, reload } = useResource(`unconfirmed-pickup:${orderHex}`, () => unconfirmedPickup(orderRef), { pollMs: POLL.signalled });
  const { data: timing = null } = useResource(checkedIn ? `order-timing:${orderHex}:at-store` : null, () => getOrderTiming(orderRef));

  const handOver = (leg: Uint8Array) => handing.run(async () => {
    await acknowledgeLeg(leg);
    setScanning(false);
    await reload();
  });

  function scanned(text: string) {
    const parsed = decodePickupCode(text);
    if (!parsed || parsed.orderHex !== orderHex) return handing.setError(t("merchantOrders.notDriverCode"));
    void handOver(parsed.leg);
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      {checkedIn ? (
        <p className="text-xs text-ink-400">
          {t("merchantOrders.checkedIn")}
          {timing?.store_late_after != null && ` ${t("merchantOrders.lateAt", { time: formatClockTime(timing.store_late_after) })}`}
        </p>
      ) : (
        <p className="text-xs text-ink-400">{t("merchantOrders.cooking")}</p>
      )}
      {code && <HandoverCode orderRef={orderRef} secret={code} giver="store" />}
      {scanning ? (
        <QrScanner onScan={scanned} />
      ) : (
        <Button className="w-full py-2 text-xs" loading={handing.busy} onClick={() => setScanning(true)}>
          {t("merchantOrders.handOver")}
        </Button>
      )}
      {pickup && !scanning && (
        <>
          <p className="mt-1 text-center text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("handoff.orType")}</p>
          <PinField value={typed} onChange={setTyped} />
          <Button
            variant="secondary"
            className="w-full py-2 text-xs"
            loading={handing.busy}
            disabled={typed.length !== HANDOFF_CODE_DIGITS}
            onClick={() => (typed === pickupDigits(pickup) ? handOver(pickup) : handing.setError(t("merchantOrders.notDriverCode")))}
          >
            {t("merchantOrders.confirmHanded")}
          </Button>
        </>
      )}
      {handing.error && <p className="text-xs text-red-600 dark:text-red-400">{handing.error}</p>}
      <p className="text-[11px] text-ink-400">{t("merchantOrders.waitNote", { minutes: Math.round(terms.store_wait_secs / 60) })}</p>
    </div>
  );
}

/// A delivery whose outcome is contested -- the store decides:
///
/// - the customer saying it never arrived: the app decides on its own once
///   the claim has stood a while with no delivery, refunding the customer
///   and taking the driver's collateral for the food, or the store can now;
/// - the driver saying nobody came to take it: paid as delivered once the
///   customer's report window has run -- and if the customer says they were
///   there, the store can side with them first, as above.
export function NeverArrivedClaim({ orderHex, orderRef, disputed }: { orderHex: string; orderRef: Uint8Array; disputed: boolean }) {
  const t = useT();
  const deciding = useAction();
  const { data: decisions, reload } = useResource(`order-decisions:${orderHex}`, () => getOrderDecisions(orderRef), { pollMs: POLL.signalled });
  if (!decisions) return null;
  if (decisions.not_delivered) return <p className="mt-2 text-xs text-ink-400">{t("merchantOrders.neverArrived")}</p>;
  const decide = () => deciding.run(async () => {
    await decideNotDelivered(orderRef);
    await reload();
  });
  const upheld = decisions.no_show_upheld_after;
  const words = upheld
    ? { title: t(disputed ? "merchantOrders.noShowDisputedTitle" : "merchantOrders.noShowTitle"), detail: t(disputed ? "merchantOrders.noShowDisputed" : "merchantOrders.noShow", { time: formatDeadline(upheld) }) }
    : { title: t("merchantOrders.claimTitle"), detail: decisions.claim_decided_after ? t("merchantOrders.claimAt", { time: formatDeadline(decisions.claim_decided_after) }) : t("merchantOrders.claim") };
  return (
    <div className="mt-3 rounded-xl bg-amber-50 p-3 dark:bg-amber-900/20">
      <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-100">
        <span className="font-semibold">{words.title}</span> {words.detail}
      </p>
      {disputed && upheld && <NoShowEvidence orderHex={orderHex} orderRef={orderRef} />}
      {/* Only a customer's claim is the store's to decide for them. */}
      {disputed && (
        <Button variant="ghost" className="mt-2 w-full py-2 text-xs" loading={deciding.busy} onClick={decide}>
          {t(upheld ? "merchantOrders.sideWithCustomer" : "merchantOrders.refundNow")}
        </Button>
      )}
      {deciding.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{deciding.error}</p>}
    </div>
  );
}

/// What a customer's told the store about their allergies, ahead of everything
/// else on its ticket: the one thing the kitchen must not miss.
export function TicketAllergies({ orderHex, orderRef }: { orderHex: string; orderRef: Uint8Array }) {
  const t = useT();
  const { data } = useResource(`for-the-store:${orderHex}`, () => getOrderPrivateDetails(orderRef));
  return data ? <AllergyRequest allergies={data.allergies} heading={t("merchantOrders.allergies")} /> : null;
}

/// Who the order's for and their note for the kitchen -- both sealed to
/// the store, opened by the zome. Read once per order: they never change.
export function ForTheStore({ orderHex, orderRef }: { orderHex: string; orderRef: Uint8Array }) {
  const t = useT();
  const { data } = useResource(`for-the-store:${orderHex}`, () => getOrderPrivateDetails(orderRef));
  if (!data) return null;
  return (
    <>
      {data.customer_name && <p className="mt-1 text-xs font-semibold text-ink-700 dark:text-ink-200">{t("merchantOrders.forName", { name: data.customer_name })}</p>}
      {data.kitchen_note && <p className="mt-1 text-xs italic text-ink-500">"{data.kitchen_note}"</p>}
    </>
  );
}

/// A ready pickup: once the collection window from its being ready has
/// passed without the customer, the store can record it uncollected and
/// keep the food's price.
export function NeverCameForPickup({ row }: { row: QueueRow }) {
  const windowSecs = useTerms().collection_window_secs;
  const t = useT();
  const now = useClock(30_000);
  const recording = useAction();
  if (now.getTime() * 1000 < row.writtenAt + windowSecs * 1_000_000 + PROOF_MARGIN_MICROS) return null;
  return (
    <>
      <Button variant="ghost" className="mt-2 w-full py-2 text-xs" loading={recording.busy} onClick={() => recording.run(async () => markPickupNotCollected(row.ref, await currentBeacon()))}>
        {t("merchantOrders.neverCame")}
      </Button>
      {recording.error && <p className="mt-2 text-xs text-red-600">{recording.error}</p>}
    </>
  );
}

/// A delivery no driver brought, which its customer is collecting: the
/// store scans their code to hand it over -- or, once the collection window
/// from its being due ready has passed without them, records it uncollected
/// and keeps the food's price.
export function CollectionHandoff({ row }: { row: QueueRow }) {
  const windowSecs = useTerms().collection_window_secs;
  const t = useT();
  const now = useClock(30_000);
  const [scanning, setScanning] = useState(false);
  // A scanner reads a held-up code many times a second: one hand-over.
  const handing = useAction();
  // From when the food's due ready, or the store recorded them coming if
  // that's later -- as the network counts it.
  const overdue = now.getTime() * 1000 >= Math.max(row.writtenAt, row.order.ready_by ?? 0) + windowSecs * 1_000_000 + PROOF_MARGIN_MICROS;
  const act = (change: () => Promise<unknown>) => handing.run(async () => {
    await change();
    setScanning(false);
  });

  function scanned(text: string) {
    const code = decodeHandoverCode(text);
    if (!code || code.orderHex !== row.hex) return handing.setError(t("merchantOrders.notOrderCode"));
    void act(() => handOverCollection(row.ref, code.secret));
  }

  return (
    <div className="mt-3">
      <p className="text-xs text-ink-400">{t("merchantOrders.collecting")}</p>
      {scanning ? (
        <div className="mt-2">
          <QrScanner onScan={scanned} />
        </div>
      ) : (
        <Button className="mt-2 w-full py-2 text-xs" loading={handing.busy} onClick={() => setScanning(true)}>
          {t("handoff.scan")}
        </Button>
      )}
      {overdue && (
        <Button variant="ghost" className="mt-2 w-full py-2 text-xs" loading={handing.busy} onClick={() => act(async () => markNotCollected(row.ref, await currentBeacon()))}>
          {t("merchantOrders.neverCame")}
        </Button>
      )}
      {handing.error && <p className="mt-2 text-xs text-red-600">{handing.error}</p>}
    </div>
  );
}
