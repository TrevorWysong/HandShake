// Paying a payee by card: their processor's own card form, in its own
// frames (`cardFormFor`) -- or, where the payer saved a card with them, that
// card in one tap. What it hands back is a single-use token for the payee
// alone; the caller offers it (`offerPayment`), and `PaymentStatus` follows
// it from there.
import { useCallback, useState } from "react";
import { Lock } from "lucide-react";
import type { PaymentInput, PaymentProfile } from "../../holochain/types";
import { cardFormFor, type CardForm } from "../../lib/payments/cardForm";
import { useAction } from "../../lib/hooks/useAction";
import { formatCents } from "../../lib/ui/format";
import { describeError } from "../../lib/ui/errors";
import { useTerms } from "../../store/network";
import { useT } from "../../i18n";
import { Button, Skeleton, Switch } from "../ui";
import { Sheet } from "../Sheet";

export function PaySheet({
  profile,
  payee,
  amountCents,
  title,
  subtitle,
  offerToSave = false,
  onClose,
  onCard,
}: {
  /// How the payee is paid.
  profile: PaymentProfile;
  /// Who's being paid, as the payer knows them.
  payee: string;
  /// What will be held on the card.
  amountCents: number;
  title: string;
  subtitle?: string;
  /// Whether to offer keeping this card with the payee: between a store and
  /// its driver, never for a customer.
  offerToSave?: boolean;
  onClose: () => void;
  /// The card, to offer: resolves once it's offered.
  onCard: (card: PaymentInput) => Promise<void>;
}) {
  const t = useT();
  const currency = useTerms().currency;
  // One form for the sheet's life: re-rendering mustn't rebuild a form
  // someone's typing into.
  const [form] = useState<CardForm>(() => cardFormFor(profile, { amountCents, currency, label: payee }));
  const [save, setSave] = useState(false);
  // The processor's form arrives from its own servers: a placeholder holds
  // its place until it's drawn.
  const [ready, setReady] = useState(false);
  const action = useAction();
  const { setError, run } = action;
  // A wallet pays from its own button, inside the processor's form. A
  // sheet is opened for one payment, so the offer it was opened with is
  // the one its wallets make.
  const [offerWallet] = useState(() => onCard);

  // The processor's form, mounted into its node and torn down with it.
  const mountForm = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      let gone = false;
      const wallet = { onToken: (token: string) => void run(() => offerWallet({ token, save: false, work: null })), onError: (err: unknown) => !gone && setError(describeError(err)) };
      form.mount(node, wallet).then(
        () => !gone && setReady(true),
        (err) => !gone && setError(describeError(err)),
      );
      return () => {
        gone = true;
        form.destroy();
      };
    },
    [form, setError, run, offerWallet],
  );

  const pay = () =>
    action.run(async () => {
      const token = await form.tokenize();
      await onCard({ token, save: offerToSave && save, work: null });
    });

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      footer={
        <>
          {action.error && <p role="alert" className="mb-2 text-xs text-red-600 dark:text-red-400">{action.error}</p>}
          <Button className="w-full" loading={action.busy} disabled={!ready} onClick={pay}>
            {t("pay.hold", { amount: formatCents(amountCents) })}
          </Button>
          <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-400">
            <Lock size={11} className="-mt-0.5 mr-1 inline" />
            {t("pay.heldNotCharged", { payee })}
          </p>
        </>
      }
    >
      <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl bg-ink-50 px-4 py-3 dark:bg-ink-800/60">
        <span className="min-w-0 text-sm text-ink-500 dark:text-ink-400">{t("pay.heldFor", { payee })}</span>
        <span className="shrink-0 text-lg font-black tabular-nums text-ink-900 dark:text-ink-50">{formatCents(amountCents)}</span>
      </div>
      <>
          <div className="relative min-h-[3.5rem]">
            <div ref={mountForm} />
            {!ready && <Skeleton className="absolute inset-0 rounded-xl" />}
          </div>
          {offerToSave && (
            <label className="mt-4 flex items-start justify-between gap-3 text-sm">
              <span>
                <span className="font-semibold text-ink-800 dark:text-ink-100">{t("pay.remember", { payee })}</span>
                <span className="mt-0.5 block text-xs text-ink-400">{t("pay.rememberDetail", { payee })}</span>
              </span>
              <Switch checked={save} label={t("pay.remember", { payee })} onChange={setSave} />
            </label>
          )}
      </>
    </Sheet>
  );
}
