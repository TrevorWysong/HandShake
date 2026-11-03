// The caller's payments on an order, whoever they are in it: the customer's
// for their order, the store's for its driver's pay, the driver's for their
// collateral. Each shows its payee's card form until it's offered -- for
// exactly what the network has held (`myPaymentsOwed`) -- then where it
// stands (`PaymentStatus`). And for a driver, whether the store has held
// their pay.
import { useState } from "react";
import { CheckCircle2, Clock } from "lucide-react";
import type { ActionHash, AgentPubKey, PaymentLeg, PaymentOwed } from "../../holochain/types";
import { bytesToHex } from "../../holochain/decode";
import { myPayment, myPaymentsOwed, offerPayment, paymentHold, paymentProfileOf } from "../../holochain/zomes/payments";
import { useResource } from "../../lib/hooks/useResource";
import { POLL } from "../../lib/network/poll";
import { formatCents } from "../../lib/ui/format";
import { useT, type MessageKey } from "../../i18n";
import { Button, Notice } from "../ui";
import { PaySheet } from "./PaySheet";
import { PaymentStatus } from "./PaymentStatus";

/// A payment signal, or an order's: what changes what's owed.
const isPaymentSignal = (signal: object) => "PaymentChanged" in signal || "OrderUpdated" in signal || "OrderChanged" in signal;
const legKey = (leg: PaymentLeg) => JSON.stringify(leg, (_, v) => (v instanceof Uint8Array ? bytesToHex(v) : v));

/// What each leg's button, sheet and payee are called.
function wording(leg: PaymentLeg, delivery: boolean): { action: MessageKey; subtitle: MessageKey; payee: MessageKey } {
  if (leg === "Customer") return { action: "pay.payNow", subtitle: delivery ? "cart.paySubtitleDelivery" : "cart.paySubtitlePickup", payee: "cart.theStore" };
  if ("DriverPay" in leg) return { action: "pay.payDriver", subtitle: "pay.driverPaySubtitle", payee: "pay.yourDriver" };
  return { action: "pay.putUpCollateral", subtitle: "pay.collateralSubtitle", payee: "cart.theStore" };
}

export function OrderPayments({ order, delivery, compact = false }: { order: ActionHash; delivery: boolean; compact?: boolean }) {
  const { data: owed } = useResource(`payments-owed:${bytesToHex(order)}`, () => myPaymentsOwed(order), { pollMs: POLL.slow, refreshOn: isPaymentSignal });
  if (!owed?.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {owed.map((o) => (
        <OwedPayment key={legKey(o.leg)} order={order} owed={o} delivery={delivery} compact={compact} />
      ))}
    </div>
  );
}

function OwedPayment({ order, owed, delivery, compact }: { order: ActionHash; owed: PaymentOwed; delivery: boolean; compact: boolean }) {
  const t = useT();
  const words = wording(owed.leg, delivery);
  const payee = t(words.payee);
  const key = `${bytesToHex(order)}:${legKey(owed.leg)}`;
  const { data: profile } = useResource(`payment-profile:${bytesToHex(owed.payee)}`, () => paymentProfileOf(owed.payee));
  const { data: standing, reload } = useResource(`my-payment:${key}`, () => myPayment(order, owed.leg), { pollMs: POLL.slow, refreshOn: isPaymentSignal });
  const [paying, setPaying] = useState(false);

  if (standing === undefined || profile === undefined) return null;
  if (standing !== null) return <PaymentStatus order={order} leg={owed.leg} profile={profile} payee={payee} amountCents={owed.amount} compact={compact} />;
  if (!profile) return <Notice tone="warn">{t("pay.payeeNoCards", { payee })}</Notice>;
  return (
    <>
      <Button className="w-full" onClick={() => setPaying(true)}>
        {t(words.action, { amount: formatCents(owed.amount) })}
      </Button>
      {paying && (
        <PaySheet
          profile={profile}
          payee={payee}
          amountCents={owed.amount}
          title={t(words.action, { amount: formatCents(owed.amount) })}
          subtitle={t(words.subtitle)}
          onClose={() => setPaying(false)}
          onCard={async (card) => {
            await offerPayment(order, owed.leg, card);
            setPaying(false);
            await reload();
          }}
        />
      )}
    </>
  );
}

/// A driver's pay on an order: held on the store's card yet, or not.
export function DriverPayHeld({ order, bid, me }: { order: ActionHash; bid: ActionHash; me: AgentPubKey }) {
  const t = useT();
  const { data: myProfile } = useResource(`payment-profile:${bytesToHex(me)}`, () => paymentProfileOf(me));
  const { data: held } = useResource(`driver-pay:${bytesToHex(order)}:${bytesToHex(bid)}`, () => paymentHold(order, { DriverPay: { bid } }), { pollMs: POLL.slow, refreshOn: isPaymentSignal });
  if (myProfile === null) return <Notice tone="warn">{t("pay.setUpToBePaid")}</Notice>;
  if (held === undefined) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-ink-500 dark:text-ink-400">
      {held ? <CheckCircle2 size={13} className="text-presence-600" /> : <Clock size={13} />}
      {held ? t("pay.yourPayHeld") : t("pay.yourPayWaiting")}
    </p>
  );
}
