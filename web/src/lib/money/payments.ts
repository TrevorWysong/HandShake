// How payments read, wherever money is shown: what each was for, and which
// way it went for the person reading.
import type { AgentPubKey, PaymentLeg } from "../../holochain/types";
import { bytesEqual } from "../../holochain/decode";
import { t } from "../../i18n";

/// What a leg of an order's payment is, as its payer or payee reads it.
export function legLabel(leg: PaymentLeg, asPayer: boolean): string {
  if (leg === "Customer") return asPayer ? t("payments.leg.order") : t("payments.leg.orderPaid");
  if ("DriverPay" in leg) return asPayer ? t("payments.leg.driverPay") : t("payments.leg.deliveryPay");
  return asPayer ? t("payments.leg.collateral") : t("payments.leg.collateralTaken");
}

/// One payment, as `me` reads it: what it was, which way it went, and how
/// much -- what was charged once it settled, what's held until then.
export function describePayment(payment: { leg: PaymentLeg; payer: AgentPubKey; payee: AgentPubKey; held: number; charged: number | null }, me: AgentPubKey): { label: string; direction: "in" | "out"; amount: number; pending: boolean } {
  const asPayer = bytesEqual(payment.payer, me);
  return { label: legLabel(payment.leg, asPayer), direction: asPayer ? "out" : "in", amount: payment.charged ?? payment.held, pending: payment.charged === null };
}
