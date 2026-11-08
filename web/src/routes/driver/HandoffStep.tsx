// The driver handing an order to its customer. The customer proves it one
// of three ways: the driver scans their code, types the digits they read
// out (their app checks them), or they confirm in their own app. An order
// the customer chose to have left at the door needs only the drop-off and
// a photo. (At the store, the store records the handover -- see
// `AtTheStore`.) Nobody coming to the door: once the driver has recorded
// arriving (which tells the customer) and waited the network's wait, they
// can say so -- see `NobodyCame`.
import { retrying } from "../../lib/network/retry";
import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BellRing, CheckCircle2, DoorOpen, ScanLine, Smartphone } from "lucide-react";
import { getLegsForOrder, handoffByCode, recordLeg } from "../../holochain/zomes/attestation";
import { completeDelivery, customerNotHere, getOrderDecisions } from "../../holochain/zomes/dispatch";
import { actionHash, bytesEqual, bytesToHex, decodeEntry, timestampOf } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { HANDOFF_CODE_DIGITS, type DeliveryOrder, type GeoPoint, type Leg, type PinSecret } from "../../holochain/types";
import { useResource } from "../../lib/hooks/useResource";
import { useClock } from "../../lib/hooks/useClock";
import { useTerms } from "../../store/network";
import { currentBeacon, PROOF_MARGIN_MICROS } from "../../lib/network/timeSource";
import { formatClockTime, formatDeadline } from "../../lib/ui/format";
import { POLL } from "../../lib/network/poll";
import { decodeHandoverCode, matchesCommitment } from "../../lib/orders/handoverCode";
import { Button, Notice } from "../../components/ui";
import { PinField } from "../../components/orders/PinField";
import { PhotoInput } from "../../components/PhotoInput";
import { QrScanner } from "../../components/QrScanner";
import { Sheet } from "../../components/Sheet";
import { t as translate, useT, type MessageKey } from "../../i18n";
import { useAction } from "../../lib/hooks/useAction";

const COPY = { scan: "handoff.scan", confirm: "handoff.complete", done: "handoff.waiting" } as const satisfies Record<string, MessageKey>;

/// A proof just written on the giver's chain takes a moment to reach this
/// conductor; the step it completes is retried until it has.
const RETRY_DELAYS_MS = [1500, 3000, 6000];

export function HandoffStep({ orderRef, order, location, onDone }: { orderRef: Uint8Array; order: DeliveryOrder; location: GeoPoint; onDone: () => Promise<void> }) {
  const t = useT();
  const [photo, setPhoto] = useState("");
  const [code, setCode] = useState("");
  const [scanned, setScanned] = useState<PinSecret | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProblem, setScanProblem] = useState<string | null>(null);
  // The handoff, once recorded -- reused for a typed code or the giver's
  // own confirmation.
  const [leg, setLeg] = useState<Uint8Array | null>(null);
  const [waitingForGiver, setWaitingForGiver] = useState(false);
  const action = useAction();
  // When this driver recorded arriving: read back from the network, so the
  // wait survives the app closing.
  const { data: arrivedAt = null, reload: reloadArrival } = useResource(`arrival:${bytesToHex(orderRef)}`, () => arrivalOf(orderRef));

  const copy = COPY;
  const leftAtDoor = order.dropoff_preference === "LeaveAtDoor";
  const commitment = order.pin_commitment;
  const orderHex = bytesToHex(orderRef);

  const onScan = useCallback(
    async (text: string) => {
      const parsed = decodeHandoverCode(text);
      if (!parsed) return setScanProblem(translate("scan.notHandShake"));
      if (parsed.orderHex !== orderHex) return setScanProblem(translate("scan.otherOrder"));
      // Checked here first, so a wrong code is caught on the spot; the
      // network checks it again.
      if (!(await matchesCommitment(parsed.secret, commitment))) return setScanProblem(translate("handoff.wrongCode"));
      navigator.vibrate?.(40);
      setScanned(parsed.secret);
      setScanProblem(null);
      setScanning(false);
    },
    [orderHex, commitment],
  );

  async function record(extra: { scanned?: PinSecret; left_at_door?: boolean }): Promise<Uint8Array> {
    const record = await recordLeg({
      order_ref: orderRef,
      sequence: 1,
      kind: "CustomerHandoff",
      to: order.requester,
      geo_at_completion: location,
      photo_data_uri: photo,
      ...extra,
    });
    const hash = actionHash(record);
    setLeg(hash);
    await reloadArrival();
    return hash;
  }

  const complete = async () => void (await retrying(() => completeDelivery(orderRef), RETRY_DELAYS_MS));

  const run = (step: () => Promise<void>) => action.run(async () => {
    await step();
    await onDone();
  });

  const finishWithScan = () =>
    run(async () => {
      await record({ scanned: scanned! });
      await complete();
    });
  const finishWithCode = () =>
    run(async () => {
      await handoffByCode(leg ?? (await record({})), code);
      await complete();
    });
  const finishAtDoor = () =>
    run(async () => {
      await record({ left_at_door: true });
      await complete();
    });
  const askGiverToConfirm = () =>
    run(async () => {
      if (!leg) await record({});
      setWaitingForGiver(true);
    });
  // A customer who confirms completes the delivery themselves.
  const checkAgain = () => run(complete);
  // Nobody answering: arriving is recorded (the customer's told), and the
  // wait starts.
  const nobodyAnswering = () => action.run(async () => {
    if (!arrivedAt) await record({});
  });
  const sayNotHere = () => run(async () => {
    await customerNotHere(orderRef, await currentBeacon());
  });

  if (leftAtDoor) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-2xl bg-ink-50 p-4 dark:bg-ink-800/60">
          <DoorOpen size={20} className="mt-0.5 shrink-0 text-ink-500" />
          <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">
            <span className="font-semibold text-ink-900 dark:text-ink-50">{t("handoff.door")}</span> {t("handoff.doorDetail")}
          </p>
        </div>
        <PhotoInput value={photo} onChange={setPhoto} shape="banner" className="w-full" />
        {action.error && <ErrorNote message={action.error} />}
        <Button className="w-full" loading={action.busy} disabled={!photo} onClick={finishAtDoor}>
          {t("handoff.leftAtDoor")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AnimatePresence mode="wait" initial={false}>
        {scanned ? (
          <motion.div key="verified" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex items-center gap-3 rounded-2xl bg-green-50 p-4 dark:bg-green-900/20">
            <CheckCircle2 size={28} className="shrink-0 text-green-600" />
            <div>
              <p className="text-sm font-bold text-green-800 dark:text-green-200">{t("handoff.verified")}</p>
              <p className="text-xs text-green-700/80 dark:text-green-300/80">{t("handoff.paidOnConfirm")}</p>
            </div>
          </motion.div>
        ) : waitingForGiver ? (
          <motion.div key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-start gap-3 rounded-2xl bg-ink-50 p-4 dark:bg-ink-800/60">
            <Smartphone size={20} className="mt-0.5 shrink-0 text-ink-500" />
            <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">{t(copy.done)}</p>
          </motion.div>
        ) : (
          <motion.div key="collect" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-3">
            <button
              onClick={() => {
                setScanProblem(null);
                setScanning(true);
              }}
              className="flex items-center justify-center gap-2 rounded-2xl bg-ink-900 py-3.5 text-sm font-semibold text-white transition hover:opacity-90 dark:bg-ink-50 dark:text-ink-900"
            >
              <ScanLine size={17} />
              {t(copy.scan)}
            </button>
            <p className="text-center text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("handoff.orType")}</p>
            <PinField value={code} onChange={setCode} />
          </motion.div>
        )}
      </AnimatePresence>

      {!waitingForGiver && (
        <div>
          <p className="mb-2 text-xs font-semibold text-ink-500">{t("handoff.photo")}</p>
          <PhotoInput value={photo} onChange={setPhoto} shape="banner" className="w-full" />
        </div>
      )}

      {action.error && <ErrorNote message={action.error} />}
      {scanned ? (
        <Button className="w-full" loading={action.busy} onClick={finishWithScan}>
          {t(copy.confirm)}
        </Button>
      ) : waitingForGiver ? (
        <Button variant="ghost" className="w-full" loading={action.busy} onClick={checkAgain}>
          {t("handoff.checkAgain")}
        </Button>
      ) : (
        <>
          <Button className="w-full" loading={action.busy} disabled={code.length !== HANDOFF_CODE_DIGITS} onClick={finishWithCode}>
            {t(copy.confirm)}
          </Button>
          <button onClick={askGiverToConfirm} disabled={action.busy} className="-mt-1 text-center text-xs font-semibold text-ink-500 underline-offset-4 hover:underline disabled:opacity-50">
            {t("handoff.theyConfirm")}
          </button>
        </>
      )}

      {order.status !== "PickedUp" ? (
        <NoShowStanding orderRef={orderRef} />
      ) : arrivedAt === null ? (
        <div className="-mt-1 flex flex-col items-center gap-1">
          <button onClick={nobodyAnswering} disabled={action.busy || !photo} className="text-center text-xs font-semibold text-ink-500 underline-offset-4 hover:underline disabled:opacity-50 disabled:no-underline">
            {t("noShow.nobodyAnswering")}
          </button>
          {!photo && <p className="text-center text-[11px] text-ink-400">{t("noShow.photoFirst")}</p>}
        </div>
      ) : (
        <NobodyCame arrivedAt={arrivedAt} busy={action.busy} onSay={sayNotHere} />
      )}

      <Sheet open={scanning} onClose={() => setScanning(false)} title={t(copy.scan)} subtitle={t("handoff.scanSubtitle")}>
        <QrScanner onScan={onScan} />
        <AnimatePresence>
          {scanProblem && (
            <motion.p initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-center text-xs font-semibold text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {scanProblem}
            </motion.p>
          )}
        </AnimatePresence>
        <button onClick={() => setScanning(false)} className="mt-4 w-full py-2 text-sm font-semibold text-ink-500 hover:text-ink-800 dark:hover:text-ink-200">
          {t("handoff.typeInstead")}
        </button>
      </Sheet>
    </div>
  );
}

/// When this driver recorded arriving at `orderRef`'s drop-off (µs): their
/// latest handoff there no code or door completes -- `null` before one.
async function arrivalOf(orderRef: Uint8Array): Promise<number | null> {
  const me = myAgentPubKey();
  const arrivals = (await getLegsForOrder(orderRef))
    .filter((record) => {
      const leg = decodeEntry<Leg>(record);
      return leg.kind === "CustomerHandoff" && bytesEqual(leg.from, me) && leg.revealed_pin === null && !leg.left_at_door;
    })
    .map(timestampOf);
  return arrivals.length ? Math.max(...arrivals) : null;
}

/// The driver at the door, nobody coming: the customer's been told they're
/// here, and once the network's wait has passed they may say nobody came --
/// paid as delivered, unless the customer disputes it and the store sides
/// with them.
function NobodyCame({ arrivedAt, busy, onSay }: { arrivedAt: number; busy: boolean; onSay: () => void }) {
  const t = useT();
  const now = useClock(15_000).getTime() * 1000;
  const canSay = arrivedAt + useTerms().dropoff_wait_secs * 1_000_000 + PROOF_MARGIN_MICROS;
  const waited = now >= canSay;
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-amber-50 p-4 dark:bg-amber-900/20">
      <div className="flex items-start gap-3">
        <BellRing size={18} className="mt-0.5 shrink-0 text-amber-600" />
        <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-100">
          <span className="font-semibold">{t("noShow.toldTitle")}</span> {waited ? t("noShow.canSay") : t("noShow.waitUntil", { time: formatClockTime(canSay) })}
        </p>
      </div>
      <Button variant="ghost" className="w-full" loading={busy} disabled={!waited} onClick={onSay}>
        {t("noShow.notHere")}
      </Button>
    </div>
  );
}

/// Where the driver's word that nobody came stands: paid as delivered once
/// the customer's report window has run, unless they say they were there
/// and the store sides with them. The customer can still take it meanwhile.
function NoShowStanding({ orderRef }: { orderRef: Uint8Array }) {
  const t = useT();
  const { data: decisions } = useResource(`order-decisions:${bytesToHex(orderRef)}`, () => getOrderDecisions(orderRef), { pollMs: POLL.signalled });
  if (!decisions?.no_show_upheld_after) return null;
  return <Notice tone="warn">{t("noShow.driverSaid", { time: formatDeadline(decisions.no_show_upheld_after) })}</Notice>;
}

function ErrorNote({ message }: { message: string }) {
  return <Notice>{message}</Notice>;
}
