// This device has sent its account to a new phone (docs/RECOVERY.md): its app
// has stopped, so this is all it shows -- the sealed code for the new phone
// to scan, until the person says the new phone has the account (and this
// device lets it go), or takes it back because the new phone never
// finished. Taking it back is the network's call, not this screen's: only
// while the new phone hasn't written as the account (`take_back`). Once it
// has, this device can only let it go.
import { useState } from "react";
import { Smartphone } from "lucide-react";
import { deviceRuntime } from "../../holochain/device";
import { HOST } from "../../holochain/host";
import { useDeparture } from "../../store/departure";
import { sealedAccount } from "../../lib/account/deviceMove";
import { keyFingerprint } from "../../lib/account/accountMove";
import { CodeCard } from "./AccountCode";
import { Button } from "../ui";
import { useT } from "../../i18n";
import { takeBack } from "../../holochain/zomes/account";
import { TakeBackRefused, takeAccountBack } from "../../lib/account/handover";
import { useAction } from "../../lib/hooks/useAction";

type Step = "show" | "done" | "stay" | "removed" | "tooLate";

export function Departure({ sealed }: { sealed: string }) {
  const t = useT();
  const clear = useDeparture((s) => s.clear);
  const [step, setStep] = useState<Step>("show");
  const action = useAction();
  const account = sealedAccount(sealed);

  const act = (command: "retire" | "stay") => action.run(async () => {
    const runtime = await deviceRuntime();
    if (!runtime) throw new Error(t("move.unsupported"));
    if (command === "stay") {
      // Running again, but still handing over: it writes nothing until the
      // network says the new phone never did. Refused for good only once
      // the new phone has written; "not yet" stays here, to try again.
      await takeAccountBack(runtime, takeBack).catch((err: unknown) => {
        if (err instanceof TakeBackRefused && err.refusal === "tooLate") setStep("tooLate");
        throw err instanceof TakeBackRefused ? err.cause : err;
      });
    } else {
      await runtime.retire();
    }
    clear();
    // Taken back: the app starts again as it was. Let go: in development
    // this browser forgets the identity and signs in afresh; in a runtime
    // there's nothing left here to open.
    if (command === "stay" || HOST === "dev") window.location.reload();
    else setStep("removed");
  }, { stayBusy: true });

  return (
    <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-4 px-6 py-10 text-center text-white">
      <div className="grid h-14 w-14 place-items-center rounded-3xl bg-white text-handshake-600 shadow-xl">
        <Smartphone size={26} />
      </div>
      {step === "removed" ? (
        <>
          <h1 className="text-xl font-black">{t("departure.removedTitle")}</h1>
          <p className="max-w-sm text-sm text-white/80">{t("departure.removed")}</p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-black">{t("departure.title")}</h1>
          <p className="max-w-sm text-sm text-white/80">{t("departure.detail")}</p>
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 text-ink-900 shadow-xl dark:bg-ink-900 dark:text-ink-50">
            {step === "show" && <CodeCard code={sealed} fingerprint={account ? keyFingerprint(account) : ""} note={t("departure.note")} />}
            {step === "done" && <p className="text-sm">{t("departure.doneConfirm")}</p>}
            {step === "stay" && <p className="text-sm text-amber-700 dark:text-amber-400">{t("departure.stayWarning")}</p>}
            {step === "tooLate" && <p className="text-sm">{t("departure.tooLate")}</p>}
            {action.error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{action.error}</p>}
          </div>
          {step === "show" ? (
            <div className="flex w-full max-w-sm flex-col gap-2">
              <Button className="w-full bg-white text-handshake-600" variant="ghost" onClick={() => setStep("done")}>
                {t("departure.done")}
              </Button>
              <button type="button" onClick={() => setStep("stay")} className="text-xs text-white/70 underline underline-offset-2">
                {t("departure.stay")}
              </button>
            </div>
          ) : (
            <div className="flex w-full max-w-sm flex-col gap-2">
              <Button className="w-full bg-white text-handshake-600" variant="ghost" loading={action.busy} onClick={() => act(step === "stay" ? "stay" : "retire")}>
                {step === "stay" ? t("departure.stayConfirm") : t("departure.remove")}
              </Button>
              {step !== "tooLate" && (
                <button type="button" disabled={action.busy} onClick={() => setStep("show")} className="text-xs text-white/70 underline underline-offset-2">
                  {t("common.back")}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
