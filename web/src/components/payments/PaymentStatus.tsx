// Where one of the caller's payments stands, and what they can do about it:
// waiting on the payee's agent; a challenge their bank asks them to
// complete (3-D Secure), done in the payee's card form; declined, with why
// and another card to try; or held. Every step reads from the network --
// nothing here moves money.
import { useState } from "react";
import { CheckCircle2, CreditCard, Loader2, ShieldAlert } from "lucide-react";
import type { ActionHash, DeclineCode, PaymentInput, PaymentLeg, PaymentProfile } from "../../holochain/types";
import { bytesToHex } from "../../holochain/decode";
import { myPayment, offerPayment } from "../../holochain/zomes/payments";
import { cardFormFor } from "../../lib/payments/cardForm";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";
import { formatCents } from "../../lib/ui/format";
import { POLL } from "../../lib/network/poll";
import { useTerms } from "../../store/network";
import { useT } from "../../i18n";
import clsx from "clsx";
import type { ReactNode } from "react";
import { Button } from "../ui";
import { PaySheet } from "./PaySheet";

const TONES = {
  info: "bg-ink-50 text-ink-700 dark:bg-ink-800/60 dark:text-ink-200",
  success: "bg-presence-500/10 text-presence-600 dark:text-presence-400",
  warn: "bg-amber-50 text-amber-900 dark:bg-amber-900/20 dark:text-amber-100",
  error: "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-200",
} as const;

/// Where a payment stands, in a box of its tone.
function Panel({ tone, icon, children }: { tone: keyof typeof TONES; icon: ReactNode; children: ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={clsx("flex gap-2.5 rounded-2xl px-4 py-3 text-sm", TONES[tone])}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/// A payment signal, or an order's: what changes where a payment stands.
const isPaymentSignal = (signal: object) => "PaymentChanged" in signal || "OrderUpdated" in signal || "OrderChanged" in signal;

export function PaymentStatus({
  order,
  leg,
  profile,
  payee,
  amountCents,
  compact = false,
}: {
  order: ActionHash;
  leg: PaymentLeg;
  /// How the payee is paid -- for another card, or their bank's challenge.
  profile: PaymentProfile | null;
  payee: string;
  amountCents: number;
  /// Only say something when there's something to do.
  compact?: boolean;
}) {
  const t = useT();
  const currency = useTerms().currency;
  const key = `my-payment:${bytesToHex(order)}:${JSON.stringify(leg, (_, v) => (v instanceof Uint8Array ? bytesToHex(v) : v))}`;
  const { data: standing, reload } = useResource(key, () => myPayment(order, leg), { pollMs: POLL.payment, refreshOn: isPaymentSignal });
  const [retrying, setRetrying] = useState(false);
  const action = useAction();

  const offer = (card: PaymentInput, resumes: ActionHash | null = null) =>
    action.run(async () => {
      await offerPayment(order, leg, card, resumes);
      setRetrying(false);
      await reload();
    });

  // The bank's challenge, completed in the payee's own form; then the
  // payee's agent is told to go on.
  const completeChallenge = (challenge: string, actionRef: ActionHash) =>
    action.run(async () => {
      if (!profile) return;
      await cardFormFor(profile, { amountCents, currency }).complete(challenge);
      await offerPayment(order, leg, { token: null, save: false }, actionRef);
      await reload();
    });

  if (standing === undefined) return null;
  const retry = retrying && profile && (
    <PaySheet profile={profile} payee={payee} amountCents={amountCents} title={t("pay.anotherCardTitle")} onClose={() => setRetrying(false)} onCard={async (card) => void (await offer(card))} />
  );

  if (standing === null || "Waiting" in standing) {
    if (compact) return null;
    return (
      <Panel tone="info" icon={<Loader2 size={16} className="animate-spin" />}>
        {t("pay.confirming", { payee })}
      </Panel>
    );
  }
  if ("Held" in standing) {
    if (compact) return null;
    const { held, charged } = standing.Held;
    return (
      <Panel tone="success" icon={<CheckCircle2 size={16} />}>
        {charged === null ? t("pay.held", { amount: formatCents(held), payee }) : t("pay.charged", { amount: formatCents(charged), payee })}
      </Panel>
    );
  }
  if ("ActionNeeded" in standing) {
    const { challenge, action: actionRef } = standing.ActionNeeded;
    return (
      <Panel tone="warn" icon={<ShieldAlert size={16} />}>
        <p>{t("pay.actionNeeded")}</p>
        {action.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{action.error}</p>}
        <Button className="mt-3 px-3.5 py-1.5 text-xs" loading={action.busy} disabled={!profile} onClick={() => completeChallenge(challenge, actionRef)}>
          {t("pay.confirmWithBank")}
        </Button>
      </Panel>
    );
  }
  const { code } = standing.Declined;
  return (
    <>
      <Panel tone="error" icon={<CreditCard size={16} />}>
        <p>{declineReason(code, t)}</p>
        <Button className="mt-3 px-3.5 py-1.5 text-xs" disabled={!profile} onClick={() => setRetrying(true)}>
          {t("pay.tryAnother")}
        </Button>
      </Panel>
      {retry}
    </>
  );
}

/// Why a payment was declined, as the payer reads it.
function declineReason(code: DeclineCode, t: ReturnType<typeof useT>): string {
  return t(`pay.declined.${code}`);
}
