// This device has just received its account from another phone
// (docs/RECOVERY.md): before it writes anything -- its setup included -- it
// checks its restored chain still ends where the old phone handed it over
// (`confirm_handover`). If it does, the app carries on as the account. If the
// old phone took it back meanwhile, it's the old phone's: this one only lets
// it go, never writes as it too.
import { useState } from "react";
import { Smartphone } from "lucide-react";
import { decodeHashFromBase64 } from "@holochain/client";
import { deviceRuntime, prepareDevice } from "../../holochain/device";
import { confirmHandover } from "../../holochain/zomes/account";
import { useArrival } from "../../store/arrival";
import { describeError } from "../../lib/ui/errors";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";
import { Button } from "../ui";
import { useT } from "../../i18n";

/// How long between checks while the network catches up with the account.
const RECHECK_MS = 3000;

export function Arrival({ head }: { head: string }) {
  const t = useT();
  const clear = useArrival((s) => s.clear);
  const [takenBack, setTakenBack] = useState(false);
  const leaving = useAction();
  const { error } = useResource(
    takenBack ? null : `arrival:${head}`,
    async () => {
      try {
        await confirmHandover(decodeHashFromBase64(head));
      } catch (err) {
        // Only the network's word that the old phone wrote past it is final;
        // anything else is checked again. Read from the zome's own words,
        // before any translation.
        if (/took this account back/.test(String(err))) setTakenBack(true);
        throw err;
      }
      // The account is this device's: set up, and on into the app.
      clear();
      void prepareDevice();
      return true;
    },
    { pollMs: RECHECK_MS },
  );

  const letGo = () =>
    leaving.run(async () => {
      await (await deviceRuntime())?.retire();
      clear();
      window.location.reload();
    }, { stayBusy: true });

  return (
    <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-4 px-6 py-10 text-center text-white">
      <div className="grid h-14 w-14 place-items-center rounded-3xl bg-white text-handshake-600 shadow-xl">
        <Smartphone size={26} />
      </div>
      {takenBack ? (
        <>
          <h1 className="text-xl font-black">{t("arrival.takenBackTitle")}</h1>
          <p className="max-w-sm text-sm text-white/80">{t("arrival.takenBack")}</p>
          {leaving.error && <p className="text-xs text-red-200">{leaving.error}</p>}
          <Button className="w-full max-w-sm bg-white text-handshake-600" variant="ghost" loading={leaving.busy} onClick={letGo}>
            {t("arrival.remove")}
          </Button>
        </>
      ) : (
        <>
          <p className="max-w-sm text-sm text-white/80">{t("arrival.checking")}</p>
          {error !== undefined && <p className="max-w-sm text-xs text-white/70">{describeError(error)}</p>}
        </>
      )}
    </div>
  );
}
