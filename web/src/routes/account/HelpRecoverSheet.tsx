// Vouching for someone this person guards, once they've said who's
// recovering -- and only then.
import { useState } from "react";
import type { AgentPubKey, PlanView } from "../../holochain/types";
import { bytesEqual, bytesToHex } from "../../holochain/decode";
import { vouch } from "../../holochain/zomes/account";
import { AccountCodeReader } from "../../components/account/AccountCode";
import { Sheet } from "../../components/Sheet";
import { Button, Checkbox, Field, Select } from "../../components/ui";
import { keyFingerprint } from "../../lib/account/accountMove";
import { useAction } from "../../lib/hooks/useAction";
import { useT } from "../../i18n";
import { useDisplayName } from "./useDisplayName";

export function HelpRecoverSheet({ wards, me, onClose }: { wards: PlanView[]; me: AgentPubKey; onClose: () => void }) {
  const [successor, setSuccessor] = useState<AgentPubKey | null>(null);
  const [wardHex, setWardHex] = useState(wards.length === 1 ? bytesToHex(wards[0].account) : "");
  const t = useT();
  const [spoken, setSpoken] = useState(false);
  const [done, setDone] = useState(false);
  const vouching = useAction();
  const ward = wards.find((w) => bytesToHex(w.account) === wardHex);

  const vouchForThem = (account: AgentPubKey, to: AgentPubKey) => vouching.run(async () => {
    await vouch(account, to);
    setDone(true);
  });

  if (done) {
    return (
      <Sheet open onClose={onClose} title={t("account.vouched")} subtitle={t("account.vouchedSubtitle")}>
        <p className="text-sm text-ink-600 dark:text-ink-300">{t("account.vouchedDetail")}</p>
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("account.help")}
      subtitle={successor ? t("account.onlyIfSure") : t("account.askCode")}
      footer={
        successor ? (
          <>
            {vouching.error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{vouching.error}</p>}
            <Button className="w-full" loading={vouching.busy} disabled={!ward || !spoken} onClick={() => ward && vouchForThem(ward.account, successor)}>
              {t("account.vouch")}
            </Button>
          </>
        ) : undefined
      }
    >
      {successor ? (
        <div className="flex flex-col gap-4">
          {wards.length > 1 && (
            <Field label={t("account.whoRecovering")}>
              <Select value={wardHex} onChange={(e) => setWardHex(e.target.value)}>
                <option value="">{t("account.choose")}</option>
                {wards.map((w) => (
                  <WardOption key={bytesToHex(w.account)} ward={w} />
                ))}
              </Select>
            </Field>
          )}
          <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{t("account.theirDevice")}</p>
            <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(successor)}</p>
            <p className="mt-1 text-xs text-ink-500">{t("account.readFingerprint")}</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-ink-600 dark:text-ink-300">
            <Checkbox checked={spoken} onChange={(e) => setSpoken(e.target.checked)} className="mt-0.5" />
            {t("account.spoken")}
          </label>
          <p className="text-xs text-ink-400">{t("account.impersonation")}</p>
        </div>
      ) : (
        <AccountCodeReader
          prompt={t("account.pointTheirDevice")}
          onKey={(key) => (bytesEqual(key, me) ? vouching.setError(t("account.ownCode")) : setSuccessor(key))}
        />
      )}
      {!successor && vouching.error && <p className="mt-2 text-center text-xs text-red-600 dark:text-red-400">{vouching.error}</p>}
    </Sheet>
  );
}

function WardOption({ ward }: { ward: PlanView }) {
  return <option value={bytesToHex(ward.account)}>{useDisplayName(ward.account)}</option>;
}
