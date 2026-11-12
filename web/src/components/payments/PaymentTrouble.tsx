import { AlertTriangle } from "lucide-react";
import clsx from "clsx";
import { TimeAgo } from "../TimeAgo";
import { useT, type MessageKey } from "../../i18n";
import type { PaymentsConnection } from "../../holochain/paymentsAgent";

/// What each kind of payment the agent couldn't carry out was for.
const KIND: Record<string, MessageKey> = {
  Authorize: "payments.trouble.Authorize",
  Settle: "payments.trouble.Settle",
  Refund: "payments.trouble.Refund",
  Forget: "payments.trouble.Forget",
  Unreadable: "payments.trouble.Unreadable",
  WithdrawalUnreadable: "payments.trouble.WithdrawalUnreadable",
  RefundUnreadable: "payments.trouble.RefundUnreadable",
};

/// A payment due that this device's agent couldn't carry out lately: it
/// keeps trying, but the payee may need to look at their processor
/// account -- a revoked key, a closed account -- so it says so.
export function PaymentTrouble({ trouble, className }: { trouble: NonNullable<PaymentsConnection["trouble"]>; className?: string }) {
  const t = useT();
  const kind = KIND[trouble.what];
  return (
    <div role="status" className={clsx("flex items-start gap-2.5 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:bg-amber-900/20 dark:text-amber-100", className)}>
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <p>
        <span className="font-semibold">{kind ? t(kind) : t("payments.trouble.round")}</span>{" "}
        <TimeAgo at={trouble.at * 1000} />. {t("payments.trouble.detail")}
      </p>
    </div>
  );
}
