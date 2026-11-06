import { useMemo, useState } from "react";
import { TimeAgo } from "../../components/TimeAgo";
import { Bike, ClipboardList, ShoppingBag, Store } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import {
  acceptDeliveryOrder,
  acceptPickupOrder,
  declineOrder,
  declinePickupOrder,
  getOrderHistoryForStore,
  getOrderPrivateDetails,
  markReadyForPickup,
  setOrderStatus,
  decideNotDelivered,
  getMyPickupCode,
  getOrderTiming,
  getOrderDecisions,
  handOverCollection,
  markNotCollected,
  markPickupNotCollected,
} from "../../holochain/zomes/dispatch";
import { QrScanner } from "../../components/QrScanner";
import { decodeHandoverCode, decodePickupCode, pickupDigits } from "../../lib/orders/handoverCode";
import { storeProgress } from "../../lib/orders/progress";
import { OrderProgressBar } from "../../components/orders/OrderProgressBar";
import { AllergyRequest } from "../../components/store/Allergens";
import { itemCount, leftTheStore, mergeNewestFirst, received } from "../../lib/orders/orderEntries";
import { useMyStores, type StoreRow } from "../../store/merchantStores";
import { fetchActiveQueue, storesKey, toRow, type QueueRow } from "../../store/merchantQueue";
import { useResource } from "../../lib/hooks/useResource";
import { describeError } from "../../lib/ui/errors";
import { useAction } from "../../lib/hooks/useAction";
import { useClock } from "../../lib/hooks/useClock";
import { DECLINE_REASONS, declineLabel, responseDeadlineMs } from "../../lib/orders/storeAnswers";
import { useTerms } from "../../store/network";
import { useStoreSteps } from "../../lib/orders/storeSteps";
import { currentBeacon, PROOF_MARGIN_MICROS } from "../../lib/network/timeSource";
import { ResponseCountdown } from "../../components/orders/ResponseCountdown";
import { NoStoreYet } from "../../components/store/NoStoreYet";
import { Button, Card, Chip, ChipRow, EmptyState, Notice, SegmentedTabs, Skeleton, StatNumber } from "../../components/ui";
import { StatusBadge, PickupStatusBadge } from "../../components/orders/OrderStatus";
import { ChatPanel } from "../../components/orders/ChatPanel";
import { OrderPayments } from "../../components/payments/OrderPayments";
import { NoShowEvidence } from "../../components/orders/NoShowEvidence";
import { bytesEqual } from "../../holochain/decode";
import { formatCents, formatClockTime, formatDeadline, formatEta } from "../../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { HANDOFF_CODE_DIGITS, type DeclineReason, type Timestamp } from "../../holochain/types";
import { POLL, isOrderSignal } from "../../lib/network/poll";
import { acknowledgeLeg } from "../../holochain/zomes/attestation";
import { OrderLines } from "../../components/orders/OrderLines";
import { CustomerHistory } from "../../components/orders/CustomerHistory";
import { OrderIssues } from "../../components/orders/OrderIssues";
import { StoreAppeals } from "../../components/orders/StoreAppeals";
import { HandoverCode } from "../../components/orders/HandoverCode";
import { PinField } from "../../components/orders/PinField";
import { unconfirmedPickup } from "../../lib/orders/handoffs";
import { useT, type MessageKey } from "../../i18n";


const TABS = [
  { value: "active", label: "merchantOrders.tab.active" },
  { value: "history", label: "merchantOrders.tab.history" },
] as const satisfies readonly { value: string; label: MessageKey }[];

/// "All stores" isn't a store hex, so it can't collide with one.
const ALL_STORES = "all";

/// The prep times a kitchen picks from when it accepts an order (within
/// the network's longest), alongside the store's own usual time.
const PREP_CHOICES = [5, 10, 15, 20, 30, 45, 60];

/// A merchant's orders across every store they run, the way a DoorDash/
/// Uber Eats store tablet splits them: the **active** queue (what the
/// kitchen is working on, oldest first, polled) and **history** (every
/// order, newest first, paginated, read on demand). Each store's queues are
/// its own on the DHT (see `dispatch_integrity::order_queues`); with several
/// stores, every order is labelled with its store, since "which kitchen
/// makes this" is the first thing a multi-store owner needs to know.
export function MerchantOrders() {
  const t = useT();
  const stores = useMyStores();
  useStoreSteps((stores?.length ?? 0) > 0);
  const [filter, setFilter] = useState(ALL_STORES);
  const [tab, setTab] = useState<"active" | "history">("active");

  // A store filter that no longer matches anything (e.g. stale state)
  // quietly falls back to everything rather than showing an empty queue.
  const effectiveFilter = stores?.some((s) => s.hex === filter) ? filter : ALL_STORES;
  const visibleStores = useMemo(() => (stores ?? []).filter((s) => effectiveFilter === ALL_STORES || s.hex === effectiveFilter), [stores, effectiveFilter]);
  const storeName = useMemo(() => new Map((stores ?? []).map((s) => [s.hex, s.catalog.business_name])), [stores]);
  const multiStore = (stores?.length ?? 0) > 1;

  if (stores === null) return <QueueSkeleton />;
  if (stores.length === 0) {
    return <NoStoreYet detail={t("merchantOrders.noStoreDetail")} />;
  }

  const label = (hex: string) => (multiStore ? (storeName.get(hex) ?? t("role.Merchant")) : null);
  const scope = effectiveFilter === ALL_STORES ? t("merchantOrders.yourStores") : t("merchantOrders.thisStore");

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4 pb-8">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{t("nav.orders")}</h1>
        <SegmentedTabs tabs={TABS.map((x) => ({ ...x, label: t(x.label) }))} value={tab} onChange={setTab} />
      </motion.div>
      <StoreAppeals />
      {multiStore && (
        <ChipRow>
          <Chip active={effectiveFilter === ALL_STORES} onClick={() => setFilter(ALL_STORES)} tone="brand">
            {t("merchantOrders.allStores")}
          </Chip>
          {stores.map((s) => (
            <Chip key={s.hex} active={effectiveFilter === s.hex} onClick={() => setFilter(s.hex)} tone="brand">
              {s.catalog.business_name}
            </Chip>
          ))}
        </ChipRow>
      )}
      {/* Keyed by the stores shown: changing the filter mounts a fresh list
          (and, for history, fresh pagination) instead of resetting state. */}
      {tab === "active" ? (
        <ActiveQueue key={storesKey(visibleStores)} stores={visibleStores} storeLabel={label} scope={scope} />
      ) : (
        <OrderHistory key={storesKey(visibleStores)} stores={visibleStores} storeLabel={label} scope={scope} />
      )}
    </motion.div>
  );
}

function QueueSkeleton() {
  return (
    <div className="px-4 pt-4 pb-8">
      <Skeleton className="h-7 w-1/2 mb-4" />
      <Skeleton className="h-28 w-full mb-3" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

interface ListProps {
  stores: StoreRow[];
  storeLabel: (storeHex: string) => string | null;
  scope: string;
}

/// Polled, and re-read on every dispatch signal (a new order, a status
/// change) -- cheap because the active queue only ever holds in-progress
/// orders. Oldest first: the order a kitchen works through them.
function ActiveQueue({ stores, storeLabel, scope }: ListProps) {
  const [busyHex, setBusyHex] = useState<string | null>(null);
  const t = useT();
  // Why an action on an order failed, by order -- e.g. an order the store
  // can't accept because it's priced from an outdated menu.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const terms = useTerms();
  const windowSecs = terms.store_response_secs;
  // `now` is when this snapshot was read -- what each order's window is
  // judged against, refreshed with every poll.
  const { data, reload } = useResource(`merchant-active:${storesKey(stores)}`, async () => ({ rows: await fetchActiveQueue(stores), now: Date.now() }), {
    pollMs: POLL.signalled,
    refreshOn: isOrderSignal,
  });
  const rows = data?.rows;
  async function advance(row: QueueRow, action: OrderAction) {
    setBusyHex(row.hex);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[row.hex];
      return next;
    });
    try {
      await action(row.ref);
      await reload();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [row.hex]: describeError(err) }));
    } finally {
      setBusyHex(null);
    }
  }

  if (rows === undefined) return <QueueSkeleton />;
  if (rows.length === 0) {
    return <EmptyState icon={<ClipboardList size={32} />} title={t("merchantOrders.noActive")} subtitle={t("merchantOrders.noActiveDetail", { scope })} />;
  }
  return (
    // One list on a phone; a two-column board on a wide screen.
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start">
      <AnimatePresence initial={false}>
        {rows.map((row) => (
          <motion.div key={row.hex} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <OrderCard row={row} storeLabel={storeLabel(row.storeHex)}>
              {errors[row.hex] && (
                <Notice tone="warn" className="mt-2">{errors[row.hex]}</Notice>
              )}
              {row.order.status === "Placed" ? (
                <AnswerOrder
                  row={row}
                  windowSecs={windowSecs}
                  now={data!.now}
                  defaultPrep={stores.find((s) => s.hex === row.storeHex)?.catalog.prep_minutes ?? terms.default_prep_minutes}
                  busy={busyHex === row.hex}
                  onAdvance={(action) => advance(row, action)}
                />
              ) : (
                <ActiveActions row={row} busy={busyHex === row.hex} onAdvance={(action) => advance(row, action)} />
              )}
              {row.kind === "Pickup" && !bytesEqual(row.order.requester, row.order.merchant) && (
                <ChatPanel orderRef={row.ref} title={t("merchantOrders.chat")} counterpart={t("chat.customer")} collapsible />
              )}
            </OrderCard>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

type OrderAction = (ref: Uint8Array) => Promise<unknown>;

/// A new order, waiting on the store: Accept -- the store's check that it's
/// priced from the current menu (the zome refuses it otherwise) and, for a
/// delivery, what puts it in front of drivers -- or Decline, with a reason
/// the customer is told. Past the window it can't be accepted; the
/// customer's conductor cancels it.
function AnswerOrder({ row, windowSecs, now, defaultPrep, busy, onAdvance }: { row: QueueRow; windowSecs: number; now: number; defaultPrep: number; busy: boolean; onAdvance: (action: OrderAction) => void }) {
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

function ActiveActions(props: { row: QueueRow; busy: boolean; onAdvance: (action: OrderAction) => void }) {
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
  const minAge = useTerms().restricted_min_age;
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
      return (
        <>
          {note(t("merchantOrders.cantGet"))}
          {button(t("merchantOrders.refund"), (ref) => declinePickupOrder(ref, "Other"))}
        </>
      );
    default:
      return null;
  }
}

interface HistoryState {
  rows: QueueRow[];
  /// Per store: where its next page starts, or null once it's exhausted.
  cursors: Record<string, Timestamp | null>;
}

/// Every order, newest first, a page per store at a time -- never polled
/// (history doesn't change under you), and each "Load more" only reads the
/// next page of each store that still has one.
function OrderHistory({ stores, storeLabel, scope }: ListProps) {
  const terms = useTerms();
  const now = useClock();
  const loading = useAction();
  const t = useT();
  const { data, mutate } = useResource<HistoryState>(`merchant-history:${storesKey(stores)}`, () => fetchHistoryPages(stores, null));
  const hasMore = !!data && Object.values(data.cursors).some((cursor) => cursor !== null);

  const loadMore = (from: HistoryState) => loading.run(async () => {
    const next = await fetchHistoryPages(stores.filter((s) => from.cursors[s.hex] !== null), from.cursors);
    mutate((prev) => ({
      rows: mergeNewestFirst(prev?.rows ?? [], next.rows),
      cursors: { ...(prev?.cursors ?? {}), ...next.cursors },
    }));
  });

  if (data === undefined) return <QueueSkeleton />;
  if (data.rows.length === 0) return <EmptyState icon={<ClipboardList size={32} />} title={t("merchantOrders.noOrders")} subtitle={t("merchantOrders.noOrdersDetail", { scope })} />;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start">
      {data.rows.map((row) => (
        <OrderCard key={row.hex} row={row} storeLabel={storeLabel(row.storeHex)} showTime>
          {mayHaveOpenIssues(row, terms, now) && <OrderIssues orderRef={row.ref} role="store" />}
        </OrderCard>
      ))}
      {hasMore && (
        <Button variant="ghost" loading={loading.busy} onClick={() => loadMore(data)} className="w-full py-2 text-xs lg:col-span-2">
          {t("common.loadMore")}
        </Button>
      )}
      {loading.error && <Notice className="lg:col-span-2">{loading.error}</Notice>}
    </div>
  );
}

async function fetchHistoryPages(stores: StoreRow[], cursors: Record<string, Timestamp | null> | null): Promise<HistoryState> {
  const pages = await Promise.all(stores.map(async (store) => ({ store, page: await getOrderHistoryForStore(store.hash, cursors?.[store.hex] ?? null) })));
  return {
    rows: mergeNewestFirst([], pages.flatMap(({ store, page }) => page.orders.map((entry) => toRow(entry, store.hex)))),
    cursors: Object.fromEntries(pages.map(({ store, page }) => [store.hex, page.next_before])),
  };
}

/// Whether a finished order may still have reports to answer: completed
/// (its latest version, `writtenAt`) within the network's report window
/// plus the store's grace to answer a late one, as of `now`. Older orders
/// aren't checked, which keeps a long history cheap to show.
function mayHaveOpenIssues(row: QueueRow, terms: { report_window_secs: number; answer_grace_secs: number }, now: Date): boolean {
  const completed = row.kind === "Delivery" ? received(row.order.status) : row.order.status === "PickedUp";
  const openForMicros = (terms.report_window_secs + terms.answer_grace_secs) * 1_000_000;
  return completed && now.getTime() * 1000 - row.writtenAt < openForMicros;
}

function OrderCard({ row, storeLabel, showTime, children }: { row: QueueRow; storeLabel: string | null; showTime?: boolean; children?: React.ReactNode }) {
  const { order } = row;
  const t = useT();
  const count = itemCount(order);
  return (
    <Card className={clsx("p-4", !leftTheStore(row) && storeProgress(row).tone === "needsYou" && "ring-2 ring-amber-400/70 dark:ring-amber-600/60")}>
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
        <span className={clsx("flex items-center gap-1", row.kind === "Delivery" ? "text-handshake-600" : "text-presence-600")}>
          {row.kind === "Delivery" ? <Bike size={11} /> : <ShoppingBag size={11} />}
          {t(row.kind === "Delivery" ? "cart.delivery" : "cart.pickup")}
        </span>
        {storeLabel && (
          <span className="flex items-center gap-1 text-ink-400">
            <Store size={11} /> {storeLabel}
          </span>
        )}
        {showTime && <span className="ml-auto font-normal normal-case tracking-normal text-ink-300"><TimeAgo at={order.requested_at} /></span>}
      </div>
      {!leftTheStore(row) && (
        <div className="mt-1 mb-2">
          <p className="text-base font-black tracking-tight text-ink-900 dark:text-ink-50">{t(storeProgress(row).headline)}</p>
          <OrderProgressBar progress={storeProgress(row)} className="mt-2" />
        </div>
      )}
      <div className="flex items-center justify-between">
        <StatNumber className="text-sm">{formatCents(order.order_total)}</StatNumber>
        {leftTheStore(row) && (row.kind === "Delivery" ? <StatusBadge status={row.order.status} /> : <PickupStatusBadge status={row.order.status} />)}
      </div>
      <p className="mt-1 text-xs text-ink-400">
        {t("orders.items", { count })}
        {order.ready_by !== null && !leftTheStore(row) && <span className="font-semibold text-ink-600 dark:text-ink-300"> · {t("merchantOrders.readyBy", { time: formatClockTime(order.ready_by) })}</span>}
      </p>
      {!leftTheStore(row) && <TicketAllergies orderHex={row.hex} orderRef={row.ref} />}
      {!leftTheStore(row) && <OrderLines orderRef={row.ref} className="mt-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-800/60" />}
      {(order.kitchen_note || order.sealed_customer_name) && <ForTheStore orderHex={row.hex} orderRef={row.ref} />}
      {!leftTheStore(row) && <CustomerHistory customer={order.requester} />}
      {children}
    </Card>
  );
}

/// The driver at the counter: the store's check-in code for them to scan as
/// they arrive, then the store scanning *their* code as it hands the order
/// over -- or typing the digits under it, which match only the pickup this
/// order's driver recorded. Handing it over checks
/// them in too, if they hadn't. Checked in, the driver is owed their fee if
/// the store keeps them waiting past the network's wait.
function PickupHandoff({ orderHex, orderRef, checkedIn }: { orderHex: string; orderRef: Uint8Array; checkedIn: boolean }) {
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
function NeverArrivedClaim({ orderHex, orderRef, disputed }: { orderHex: string; orderRef: Uint8Array; disputed: boolean }) {
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
function TicketAllergies({ orderHex, orderRef }: { orderHex: string; orderRef: Uint8Array }) {
  const t = useT();
  const { data } = useResource(`for-the-store:${orderHex}`, () => getOrderPrivateDetails(orderRef));
  return data ? <AllergyRequest allergies={data.allergies} heading={t("merchantOrders.allergies")} /> : null;
}

/// Who the order's for and their note for the kitchen -- both sealed to
/// the store, opened by the zome. Read once per order: they never change.
function ForTheStore({ orderHex, orderRef }: { orderHex: string; orderRef: Uint8Array }) {
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
function NeverCameForPickup({ row }: { row: QueueRow }) {
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
/// has passed without them, records it uncollected and keeps the food's
/// price.
function CollectionHandoff({ row }: { row: QueueRow }) {
  const windowSecs = useTerms().collection_window_secs;
  const t = useT();
  const now = useClock(30_000);
  const [scanning, setScanning] = useState(false);
  // A scanner reads a held-up code many times a second: one hand-over.
  const handing = useAction();
  const overdue = now.getTime() * 1000 >= row.writtenAt + windowSecs * 1_000_000;
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
