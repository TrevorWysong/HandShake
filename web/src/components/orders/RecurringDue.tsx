// A recurring order whose time has come, or went by: the customer takes it to
// checkout or passes on it. Nothing's ordered or charged until they pay there.
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { BellRing, CalendarX2 } from "lucide-react";
import clsx from "clsx";
import { advanceRecurringTemplate } from "../../holochain/zomes/dispatch";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";
import { useCartSwitch } from "../../lib/hooks/useCartSwitch";
import { NewCartSheet } from "../store/NewCartSheet";
import { describeRecurrence } from "../../lib/orders/recurrence";
import { fetchRecurringOrders, takeToCheckout, type RecurringOrder } from "../../lib/orders/recurring";
import { POLL } from "../../lib/network/poll";
import { useT } from "../../i18n";
import { Button, Notice } from "../ui";

export function RecurringDue() {
  const { data: orders = [], reload } = useResource("customer-recurring", fetchRecurringOrders, { pollMs: POLL.signalled, refreshOn: (signal) => "RecurringOrderDue" in signal });
  const due = orders.filter((order) => order.due !== "NotYet");
  return (
    <AnimatePresence initial={false}>
      {due.map((order) => (
        <motion.div key={order.hex} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} className="mb-4">
          <DueOrder order={order} onPassed={reload} />
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

function DueOrder({ order, onPassed }: { order: RecurringOrder; onPassed: () => Promise<void> }) {
  const t = useT();
  const navigate = useNavigate();
  const action = useAction();
  const missed = order.due === "Missed";
  const Icon = missed ? CalendarX2 : BellRing;
  // It fills the bag: asked first if the bag holds an order already.
  const cartSwitch = useCartSwitch();
  const toCheckout = () => cartSwitch.ask(order.template.catalog_ref, () => void action.run(async () => navigate("/customer/cart", { state: { recurring: await takeToCheckout(order) } }), { as: "checkout" }), true);
  const pass = () => action.run(async () => {
    await advanceRecurringTemplate(order.hash);
    await onPassed();
  }, { as: "pass" });
  return (
    <div className={clsx("rounded-2xl border p-4", missed ? "border-ink-100 bg-white dark:border-ink-800 dark:bg-ink-900" : "border-handshake-200 bg-handshake-50 dark:border-handshake-800 dark:bg-handshake-900/20")}>
      <div className="flex items-start gap-3">
        <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-full", missed ? "bg-ink-100 text-ink-500 dark:bg-ink-800" : "bg-handshake-500/15 text-handshake-600")}>
          <Icon size={17} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t(missed ? "recurring.missedTitle" : "recurring.dueTitle", { store: order.storeName })}</p>
          <p className="mt-0.5 text-xs font-medium text-ink-500 dark:text-ink-400">{describeRecurrence(order.template.recurrence)}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-500 dark:text-ink-400">{t(missed ? "recurring.missedDetail" : "recurring.dueDetail")}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="ghost" className="flex-1 py-2 text-xs" loading={action.doing === "pass"} disabled={action.busy} onClick={pass}>
          {t(missed ? "recurring.dismiss" : "recurring.skip")}
        </Button>
        {/* Late, it's not pressed on them: it may no longer be what they want. */}
        <Button variant={missed ? "ghost" : "primary"} className="flex-1 py-2 text-xs" loading={action.doing === "checkout"} disabled={action.busy} onClick={toCheckout}>
          {t(missed ? "recurring.orderNow" : "recurring.review")}
        </Button>
      </div>
      {action.error && <Notice className="mt-2">{action.error}</Notice>}
      <NewCartSheet pending={cartSwitch.pending} onConfirm={cartSwitch.confirm} onCancel={cartSwitch.cancel} />
    </div>
  );
}
