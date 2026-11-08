// Moving the account to a new phone: the new one shows its code, and this
// one sends its key once the network holds everything it wrote.
import { wait } from "../../lib/network/retry";
import { useState } from "react";
import { readyToMove } from "../../holochain/zomes/account";
import { canMoveAccount, deviceRuntime } from "../../holochain/device";
import { useDeparture } from "../../store/departure";
import { invitationFingerprint, isInvitation } from "../../lib/account/deviceMove";
import { CodeReader } from "../../components/account/AccountCode";
import { Sheet } from "../../components/Sheet";
import { Button, Skeleton } from "../../components/ui";
import { useAction } from "../../lib/hooks/useAction";
import { useResource } from "../../lib/hooks/useResource";
import { useT } from "../../i18n";

/// How many times, a couple of seconds apart, this phone checks the network
/// holds everything it wrote before it sends its key.
const READY_TRIES = 30;

/// This phone's side of moving the account to a new one with its key
/// (docs/RECOVERY.md): it scans the new phone's invitation, waits until the
/// network holds everything it wrote, then stops and shows the account's
/// key sealed to that phone (`Departure`).
export function MoveSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const depart = useDeparture((s) => s.depart);
  const { data: movable } = useResource("can-move-account", canMoveAccount);
  const [invitation, setInvitation] = useState<string | null>(null);
  const moving = useAction();

  // The account leaves this device: it stays busy until it has.
  const move = (to: string) => moving.run(async () => {
    const runtime = await deviceRuntime();
    if (!runtime) throw new Error(t("move.unsupported"));
    let ready = !!runtime.oneNode;
    for (let attempt = 0; attempt < READY_TRIES && !ready; attempt++) {
      if (attempt > 0) await wait(2000);
      ready = (await readyToMove()).ready;
    }
    if (!ready) throw new Error(t("move.notReady"));
    depart(await runtime.send(to));
  }, { stayBusy: true });

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("move.title")}
      subtitle={invitation ? undefined : t("move.how")}
      footer={
        invitation ? (
          <>
            {moving.busy && <p className="mb-2 text-xs text-ink-500">{t("move.checking")}</p>}
            {moving.error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{moving.error}</p>}
            <Button className="w-full" loading={moving.busy} onClick={() => move(invitation)}>
              {t("move.go")}
            </Button>
          </>
        ) : undefined
      }
    >
      {movable === undefined ? (
        <Skeleton className="h-48 w-full" />
      ) : !movable ? (
        <p className="text-sm text-ink-600 dark:text-ink-300">{t("move.unsupported")}</p>
      ) : invitation ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{t("move.checkFingerprint")}</p>
            <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{invitationFingerprint(invitation)}</p>
          </div>
          <ul className="flex flex-col gap-2 text-sm text-ink-600 dark:text-ink-300">
            <li>{t("move.what1")}</li>
            <li className="font-semibold">{t("move.what2")}</li>
          </ul>
        </div>
      ) : (
        <CodeReader accepts={isInvitation} onCode={setInvitation} prompt={t("move.point")} refusal={t("move.notInvitation")} placeholder="handshake-move:1:…" />
      )}
    </Sheet>
  );
}
