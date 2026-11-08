// The recovery phrase: twelve words shown once, a few asked back before
// they're relied on, and the plan saved with their key.
import { useState } from "react";
import type { PlanView } from "../../holochain/types";
import { setRecoveryPlan } from "../../holochain/zomes/account";
import { Sheet } from "../../components/Sheet";
import { Button, Field, Input } from "../../components/ui";
import { useAction } from "../../lib/hooks/useAction";
import { newPhrase, phraseKey } from "../../lib/account/recoveryPhrase";
import { useT } from "../../i18n";
import { planWith } from "./plan";

/// How many of the twelve words are asked back.
const WORDS_CHECKED = 3;

export function PhraseSheet({ plan, onClose, onSaved }: { plan: PlanView | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [step, setStep] = useState<"intro" | "words" | "check">("intro");
  const t = useT();
  // Made once, kept only in memory while the sheet is open.
  const [phrase] = useState(() => newPhrase());
  const [asked] = useState(() => pickPositions(phrase.length, WORDS_CHECKED));
  const [answers, setAnswers] = useState<string[]>(() => asked.map(() => ""));
  const saving = useAction();
  const replacing = !!plan?.phrase_key;
  // Saving moves on from this sheet: it stays busy until it does.
  const savePlan = (phraseKeyNow: Uint8Array | null) => saving.run(async () => {
    await setRecoveryPlan(planWith(plan, { phrase_key: phraseKeyNow }));
    await onSaved();
  }, { stayBusy: true });

  function save() {
    if (asked.some((position, i) => answers[i].trim().toLowerCase() !== phrase[position].toLowerCase())) return saving.setError(t("account.phraseMismatch"));
    void savePlan(phraseKey(phrase).publicKey);
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("account.phrase")}
      subtitle={step === "check" ? t("account.phraseCheck") : t("account.phraseSubtitle")}
      footer={
        <>
          {saving.error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{saving.error}</p>}
          {step === "intro" && (
            <>
              <Button className="w-full" onClick={() => setStep("words")}>
                {replacing ? t("account.newPhrase") : t("account.showWords")}
              </Button>
              {replacing && (
                <button type="button" onClick={() => savePlan(null)} disabled={saving.busy} className="mt-3 w-full text-center text-xs font-semibold text-red-600 dark:text-red-400">
                  {t("account.phraseOff")}
                </button>
              )}
            </>
          )}
          {step === "words" && (
            <Button className="w-full" onClick={() => setStep("check")}>
              {t("account.written")}
            </Button>
          )}
          {step === "check" && (
            <Button className="w-full" loading={saving.busy} disabled={answers.some((a) => !a.trim())} onClick={save}>
              {replacing ? t("account.replacePhrase") : t("account.turnOnPhrase")}
            </Button>
          )}
        </>
      }
    >
      {step === "intro" && (
        <ul className="flex flex-col gap-3 text-sm text-ink-600 dark:text-ink-300">
          <li>{t("account.phraseTip1")}</li>
          <li>{t("account.phraseTip2")}</li>
          {replacing && <li className="font-semibold">{t("account.phraseTip3")}</li>}
        </ul>
      )}
      {step === "words" && (
        <ol className="grid grid-cols-2 gap-2">
          {phrase.map((word, i) => (
            <li key={i} className="flex items-baseline gap-2 rounded-xl bg-ink-50 px-3 py-2 dark:bg-ink-800">
              <span className="w-5 text-right text-xs tabular-nums text-ink-400">{i + 1}</span>
              <span className="font-mono text-sm font-semibold text-ink-900 dark:text-ink-50">{word}</span>
            </li>
          ))}
        </ol>
      )}
      {step === "check" && (
        <div className="flex flex-col gap-3">
          {asked.map((position, i) => (
            <Field key={position} label={t("account.word", { n: position + 1 })}>
              <Input
                aria-label={t("account.word", { n: position + 1 })}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                value={answers[i]}
                onChange={(e) => setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))}
              />
            </Field>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/// `count` distinct positions below `length`, in order.
function pickPositions(length: number, count: number): number[] {
  const positions = new Set<number>();
  const random = new Uint32Array(1);
  while (positions.size < count) {
    crypto.getRandomValues(random);
    positions.add(random[0] % length);
  }
  return [...positions].sort((a, b) => a - b);
}
