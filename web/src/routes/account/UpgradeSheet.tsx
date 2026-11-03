// Moving the account to the new version of HandShake (docs/MIGRATION.md).
import { useState } from "react";
import type { AgentPubKey } from "../../holochain/types";
import { bytesEqual } from "../../holochain/decode";
import { migrateOut } from "../../holochain/zomes/account";
import { MoveCodeReader } from "../../components/account/AccountCode";
import { Sheet } from "../../components/Sheet";
import { Button } from "../../components/ui";
import { keyFingerprint, packParcel } from "../../lib/account/accountMove";
import { useAction } from "../../lib/hooks/useAction";
import { useSession } from "../../store/session";
import { useT } from "../../i18n";

/// Moving the account to the new version of HandShake (docs/MIGRATION.md): the new
/// version, installed on this device or another, shows its code -- its
/// network and its key there; this one seals what's private to it, records
/// the move and closes its chain here. No money moves: it's in each
/// person's own processor account.
export function UpgradeSheet({ me, onClose }: { me: AgentPubKey; onClose: () => void }) {
  const t = useT();
  const [target, setTarget] = useState<{ network: Uint8Array; successor: AgentPubKey } | null>(null);
  const successor = target?.successor ?? null;
  const moving = useAction();

  // The account closes here: it stays busy until the app moves on.
  const move = () => moving.run(async () => {
    if (!target) return;
    await migrateOut({ network: target.network, successor: target.successor, parcel: await packParcel() });
    useSession.setState({ movedToNewVersion: true });
  }, { stayBusy: true });

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("account.upgradeTitle")}
      subtitle={successor ? t("account.checkNewVersion") : t("account.upgradeHow")}
      footer={
        successor ? (
          <>
            {moving.error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{moving.error}</p>}
            <Button className="w-full" loading={moving.busy} onClick={move}>
              {t("account.moveMine")}
            </Button>
          </>
        ) : undefined
      }
    >
      {successor ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{t("account.newVersion")}</p>
            <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(successor)}</p>
          </div>
          <ul className="flex flex-col gap-2 text-sm text-ink-600 dark:text-ink-300">
            <li>{t("account.upgradeWhat1")}</li>
            <li>{t("account.upgradeWhat2")}</li>
            <li className="font-semibold">{t("account.upgradeStops")}</li>
          </ul>
        </div>
      ) : (
        <MoveCodeReader prompt={t("account.pointNewVersion")} onMove={(found) => (bytesEqual(found.successor, me) ? moving.setError(t("account.thisVersionCode")) : setTarget(found))} />
      )}
      {!successor && moving.error && <p className="mt-2 text-center text-xs text-red-600 dark:text-red-400">{moving.error}</p>}
    </Sheet>
  );
}
