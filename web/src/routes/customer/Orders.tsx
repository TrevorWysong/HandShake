import { useState } from "react";
import { TimeAgo } from "../../components/TimeAgo";
import { Link, useNavigate } from "react-router-dom";
import { Bike, ChevronRight, ClipboardList, Pause, Play, Repeat, RotateCcw, ShoppingBag } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { getMyOrderHistory, setRecurringTemplateActive } from "../../holochain/zomes/dispatch";
import { getCatalog } from "../../holochain/zomes/catalog";
import { decodeEntry, bytesToHex } from "../../holochain/decode";
import { cartKey, useCarts } from "../../store/cart";
import { useCartReplace } from "../../lib/hooks/useCartReplace";
import { ReplaceCartSheet } from "../../components/store/ReplaceCartSheet";
import { usePolling, useResource } from "../../lib/hooks/useResource";
import { useActiveOrders } from "../../store/activeOrders";
import { customerProgress, type OrderNeed } from "../../lib/orders/progress";
import { OrderProgressBar } from "../../components/orders/OrderProgressBar";
import { OrderToneIcon } from "../../components/orders/OrderHero";
import { useSession } from "../../store/session";
import { cartLinesFromOrder, fetchMenu } from "../../lib/storefront/menu";
import { customerOrderPath, isFinished, itemCount, mergeNewestFirst, toOrderRow, type OrderRow } from "../../lib/orders/orderEntries";
import { Button, Card, EmptyState, Notice, SectionLabel, SegmentedTabs, Skeleton, StatNumber } from "../../components/ui";
import { OrderRowBadge } from "../../components/orders/OrderRowBadge";
import { formatCents } from "../../lib/ui/format";
import { describeRecurrence } from "../../lib/orders/recurrence";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { fetchRecurringOrders } from "../../lib/orders/recurring";
import { RecurringDue } from "../../components/orders/RecurringDue";
import { InfoSheet } from "../../components/InfoSheet";
import { LoadMore } from "../../components/LoadMore";
import type { MerchantCatalog, Timestamp } from "../../holochain/types";
import { useT, type MessageKey } from "../../i18n";
import { useAction } from "../../lib/hooks/useAction";


const TABS = [
  { value: "active", label: "orders.tab.active" },
  { value: "past", label: "orders.tab.past" },
] as const satisfies readonly { value: string; label: MessageKey }[];

/// A customer's orders the way DoorDash/Uber Eats show them: what's **in
/// progress** (polled, and re-read on every dispatch signal -- cheap, since
/// the active queue only holds unfinished orders) and **past** orders
/// (newest first, paginated, read on demand). Both come from the
/// customer's own queues (see `dispatch_integrity::order_queues`), so
/// neither ever reads their whole order history at once.
export function Orders() {
  const t = useT();
  const [tab, setTab] = useState<"active" | "past">("active");
  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4 pb-8">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{t("orders.title")}</h1>
        <SegmentedTabs tabs={TABS.map((x) => ({ ...x, label: t(x.label) }))} value={tab} onChange={setTab} />
      </motion.div>
      <RecurringDue />
      <RecurringOrders />
      {tab === "active" ? <ActiveOrders /> : <PastOrders />}
    </motion.div>
  );
}

function ActiveOrders() {
  const t = useT();
  // Scheduled orders are sent to their stores by the customer's conductor
  // when due (`dispatch::upkeep`) -- nothing to do here but show them. Read
  // for the whole app (`AppShell`), and the moment this screen's opened.
  const { agentPubKey } = useSession();
  const owner = agentPubKey ? bytesToHex(agentPubKey) : null;
  const { owner: readFor, orders, refresh } = useActiveOrders();
  usePolling(() => owner && refresh(owner).catch(() => undefined), {}, !!owner);
  const rows = readFor === owner ? orders?.map((o) => o.row) : undefined;

  if (rows === undefined) return <ListSkeleton />;
  return (
    <>
      {rows.length === 0 ? (
        <EmptyState icon={<ClipboardList size={32} />} title={t("orders.emptyActive")} subtitle={t("orders.emptyActiveDetail")} />
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {rows.map((row) => (
              <motion.div key={row.hex} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <ActiveOrderRow row={row} need={orders?.find((o) => o.row.hex === row.hex)?.need ?? null} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </>
  );
}

interface PastState {
  rows: OrderRow[];
  nextBefore: Timestamp | null;
}

/// Finished orders, newest first. History holds every order, so what's in
/// progress -- on the other tab -- is left out here: whatever's on the
/// active queue, or until that's read, what isn't finished. A decision can
/// finish an order whose status stays as it was (one settled as delivered,
/// one decided never delivered), and it's off the queue then.
function PastOrders() {
  const t = useT();
  const loading = useAction();
  const { data: read, mutate } = useResource<PastState>("customer-order-history", () => fetchPast(null));
  const { agentPubKey } = useSession();
  const { owner, orders: active } = useActiveOrders();
  const activeHex = owner && agentPubKey && owner === bytesToHex(agentPubKey) && active ? new Set(active.map((o) => o.row.hex)) : null;
  const data = read && { ...read, rows: read.rows.filter((row) => (activeHex ? !activeHex.has(row.hex) : isFinished(row))) };

  const loadMore = (before: Timestamp) => loading.run(async () => {
    const next = await fetchPast(before);
    mutate((prev) => ({ rows: mergeNewestFirst(prev?.rows ?? [], next.rows), nextBefore: next.nextBefore }));
  });

  if (data === undefined) return <ListSkeleton />;
  if (data.rows.length === 0 && data.nextBefore === null) {
    return <EmptyState icon={<ClipboardList size={32} />} title={t("orders.emptyPast")} subtitle={t("orders.emptyPastDetail")} />;
  }
  return (
    <div className="flex flex-col gap-3">
      {data.rows.map((row) => (
        <OrderCard key={row.hex} row={row} showTime>
          <ReorderButton row={row} />
        </OrderCard>
      ))}
      {data.nextBefore !== null && <LoadMore loading={loading.busy} failed={!!loading.error} onMore={() => data.nextBefore && loadMore(data.nextBefore)} />}
      {loading.error && <Notice>{loading.error}</Notice>}
    </div>
  );
}

async function fetchPast(before: Timestamp | null): Promise<PastState> {
  const page = await getMyOrderHistory(before);
  return { rows: page.orders.map(toOrderRow), nextBefore: page.next_before };
}

/// An order in progress: where it stands, large, as its own page and the
/// app's card say it.
function ActiveOrderRow({ row, need }: { row: OrderRow; need: OrderNeed | null }) {
  const t = useT();
  const storeHex = bytesToHex(row.order.catalog_ref);
  const { data: storeName } = useResource(`store-name:${storeHex}`, async () => decodeEntry<MerchantCatalog>(await getCatalog(row.order.catalog_ref)).business_name);
  const progress = customerProgress(row, need);
  return (
    <Link to={customerOrderPath(row)} className={clsx("block rounded-2xl border bg-white p-4 shadow-[var(--shadow-card)] transition-transform active:scale-[0.99] dark:bg-ink-900", progress.tone === "needsYou" ? "border-amber-400 dark:border-amber-600" : "border-ink-100 dark:border-ink-800")}>
      <span className="flex items-center gap-3">
        <OrderToneIcon tone={progress.tone} size={18} className="h-10 w-10" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-black tracking-tight text-ink-900 dark:text-ink-50">{t(progress.headline)}</span>
          <span className="block truncate text-xs text-ink-500 dark:text-ink-400">{storeName ?? "\u00a0"} · {t("orders.items", { count: itemCount(row.order) })} · {formatCents(row.order.order_total)}</span>
        </span>
        <ChevronRight size={16} className="shrink-0 text-ink-300" />
      </span>
      <OrderProgressBar progress={progress} className="mt-3" />
    </Link>
  );
}

/// One order in the list: which store, what it came to, where it stands.
function OrderCard({ row, showTime, children }: { row: OrderRow; showTime?: boolean; children?: React.ReactNode }) {
  const t = useT();
  const count = itemCount(row.order);
  const storeHex = bytesToHex(row.order.catalog_ref);
  const { data: storeName } = useResource(`store-name:${storeHex}`, async () => decodeEntry<MerchantCatalog>(await getCatalog(row.order.catalog_ref)).business_name);
  return (
    <Card className="flex items-center gap-2 p-4">
      <Link to={customerOrderPath(row)} className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
          <span className={clsx("flex items-center gap-1", row.kind === "Delivery" ? "text-handshake-600" : "text-presence-600")}>
            {row.kind === "Delivery" ? <Bike size={11} /> : <ShoppingBag size={11} />}
            {t(row.kind === "Delivery" ? "cart.delivery" : "cart.pickup")}
          </span>
          {showTime && <span className="font-normal normal-case tracking-normal text-ink-300"><TimeAgo at={row.order.requested_at} /></span>}
        </div>
        <p className="truncate text-sm font-bold text-ink-900 dark:text-ink-50">{storeName ?? "\u00a0"}</p>
        <p className="text-xs text-ink-400">
          {t("orders.items", { count })} · <StatNumber className="text-xs">{formatCents(row.order.order_total)}</StatNumber>
        </p>
      </Link>
      <OrderRowBadge row={row} />
      {children}
    </Card>
  );
}

/// Rebuilds the cart from a past order against the store's *current* menu:
/// an item since removed is dropped and a repriced one takes its new price,
/// rather than failing the whole reorder over one stale line.
function ReorderButton({ row }: { row: OrderRow }) {
  const t = useT();
  const navigate = useNavigate();
  const reordering = useAction();
  const replacing = useCartReplace();

  const reorder = () => reordering.run(async () => {
    const { order } = row;
    const [catalogRecord, menuItems] = await Promise.all([getCatalog(order.catalog_ref), fetchMenu(order.catalog_ref)]);
    const catalog = decodeEntry<MerchantCatalog>(catalogRecord);
    const lines = await cartLinesFromOrder(order.catalog_ref, order.lines, menuItems);
    useCarts.getState().setCart(order.catalog_ref, order.merchant, catalog.business_name, lines);
    navigate(`/customer/cart/${cartKey(order.catalog_ref)}`);
  });

  return (
    <>
      <Button variant="ghost" className="px-2.5 py-1.5 text-xs" loading={reordering.busy} onClick={() => replacing.ask(row.order.catalog_ref, reorder)} aria-label={reordering.error ?? t("orders.reorder")} title={reordering.error ?? undefined}>
        <RotateCcw size={13} />
      </Button>
      <ReplaceCartSheet pending={replacing.pending} onConfirm={replacing.confirm} onCancel={replacing.cancel} />
    </>
  );
}

/// Recurring templates only change through this section's own toggle
/// (which reloads them), so they're read once, not polled.
function RecurringOrders() {
  const t = useT();
  const toggling = useAction();
  const { data: templates, reload } = useResource("customer-recurring", fetchRecurringOrders);
  const sections = (["ask", "pay", "closed"] as const).map((part) => ({ title: t(`recurring.why.${part}`), body: t(`recurring.why.${part}Detail`) }));

  const toggle = (hash: Uint8Array, hex: string, active: boolean) => toggling.run(async () => {
    await setRecurringTemplateActive(hash, !active);
    await reload();
  }, { as: hex });

  if (!templates?.length) return null;
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel icon={<Repeat size={13} />}>{t("orders.recurring")}</SectionLabel>
        <InfoSheet title={t("recurring.how")} sections={sections} />
      </div>
      <div className="flex flex-col gap-2">
        {templates.map(({ hash, hex, template, storeName }) => (
          <Card key={hex} className="flex items-center justify-between p-3.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{storeName}</p>
              <p className="text-xs text-ink-400">{describeRecurrence(template.recurrence)}</p>
            </div>
            <Button variant={template.active ? "secondary" : "ghost"} className="px-3 py-1.5 text-xs" loading={toggling.doing === hex} disabled={toggling.busy} onClick={() => toggle(hash, hex, template.active)}>
              {template.active ? <Pause size={13} /> : <Play size={13} />} {template.active ? t("orders.active") : t("orders.paused")}
            </Button>
          </Card>
        ))}
      </div>
      {toggling.error && <Notice className="mt-2">{toggling.error}</Notice>}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div>
      <Skeleton className="h-16 w-full mb-3" />
      <Skeleton className="h-16 w-full mb-3" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
