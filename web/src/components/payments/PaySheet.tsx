// Paying a payee by card: their processor's own card form, in its own
// frames (`cardFormFor`) -- or, where the payer saved a card with them, that
// card in one tap. What it hands back is a single-use token for the payee
// alone; the caller offers it (`offerPayment`), and `PaymentStatus` follows
// it from there.
import { useCallback, useState } from "react";
import { CreditCard, Lock } from "lucide-react";
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
  canUseSaved = false,
  offerToSave = true,
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
  /// The payer saved a card with this payee before.
  canUseSaved?: boolean;
  /// Whether to offer keeping this card with the payee.
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
  const [useNew, setUseNew] = useState(!canUseSaved);
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
      const wallet = { onToken: (token: string) => void run(() => offerWallet({ token, save: false })), onError: (err: unknown) => !gone && setError(describeError(err)) };
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
      if (!useNew) return onCard({ token: null, save: false });
      const token = await form.tokenize();
      await onCard({ token, save: offerToSave && save });
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
          <Button className="w-full" loading={action.busy} disabled={useNew && !ready} onClick={pay}>
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
      {canUseSaved && (
        <div className="mb-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setUseNew(false)}
            className={`flex items-center gap-3 rounded-2xl border p-4 text-left ${!useNew ? "border-handshake-500 bg-handshake-50 dark:bg-handshake-900/20" : "border-ink-100 dark:border-ink-800"}`}
          >
            <CreditCard size={20} className="text-ink-400" />
            <span className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("pay.savedCard", { payee })}</span>
          </button>
          {!useNew && (
            <button type="button" onClick={() => setUseNew(true)} className="text-xs font-semibold text-ink-500 hover:text-ink-700 dark:hover:text-ink-300">
              {t("pay.anotherCard")}
            </button>
          )}
        </div>
      )}
      {useNew && (
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
      )}
    </Sheet>
  );
}
