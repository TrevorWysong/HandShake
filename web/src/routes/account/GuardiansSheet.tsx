// Guardians: the people who can vouch to recover this account, added by
// their code, and how many of them it takes.
import { useState } from "react";
import { encodeHashToBase64 } from "@holochain/client";
import { Trash2, UserPlus, Users } from "lucide-react";
import type { AgentPubKey, PlanView } from "../../holochain/types";
import { bytesEqual, bytesToHex } from "../../holochain/decode";
import { setRecoveryPlan } from "../../holochain/zomes/account";
import { MAX_GUARDIANS } from "../../holochain/types";
import { AccountCodeReader } from "../../components/account/AccountCode";
import { Sheet } from "../../components/Sheet";
import { Button, Field, Input, Select } from "../../components/ui";
import { keyFingerprint } from "../../lib/account/accountMove";
import { useAction } from "../../lib/hooks/useAction";
import { useGuardianNames } from "../../store/guardianNames";
import { useT } from "../../i18n";
import { planWith } from "./plan";

export function GuardiansSheet({ plan, me, onClose, onSaved }: { plan: PlanView | null; me: AgentPubKey; onClose: () => void; onSaved: () => Promise<void> }) {
  const { names, setName } = useGuardianNames();
  const t = useT();
  const [guardians, setGuardians] = useState<AgentPubKey[]>(plan?.guardians ?? []);
  const [threshold, setThreshold] = useState(plan?.threshold || 1);
  const [adding, setAdding] = useState<AgentPubKey | "scan" | null>(null);
  const [newName, setNewName] = useState("");
  const saving = useAction();

  function scanned(key: AgentPubKey) {
    saving.setError(null);
    if (bytesEqual(key, me)) return saving.setError(t("account.ownCodeGuardian"));
    if (guardians.some((g) => bytesEqual(g, key))) return saving.setError(t("account.alreadyGuardian"));
    setAdding(key);
  }

  function add() {
    if (!(adding instanceof Uint8Array)) return;
    setName(encodeHashToBase64(adding), newName);
    const next = [...guardians, adding];
    setGuardians(next);
    // More than half, by default: two recoveries of one account would need
    // a guardian on both sides.
    setThreshold(Math.floor(next.length / 2) + 1);
    setAdding(null);
    setNewName("");
  }

  // Nothing to save until they're not what's saved.
  const before = plan?.guardians ?? [];
  const unchanged = guardians.length === before.length && guardians.every((g, i) => bytesEqual(g, before[i])) && threshold === (plan?.threshold || 1);

  const save = () => saving.run(async () => {
    await setRecoveryPlan(planWith(plan, { guardians, threshold }));
    await onSaved();
  }, { stayBusy: true });

  if (adding !== null) {
    return (
      <Sheet open onClose={() => setAdding(null)} title={t("account.addGuardian")} subtitle={adding === "scan" ? t("account.scanGuardian") : t("account.checkThem")}>
        {adding === "scan" ? (
          <>
            {saving.error && <p className="mb-3 text-xs text-red-600 dark:text-red-400">{saving.error}</p>}
            <AccountCodeReader onKey={scanned} prompt={t("account.pointGuardian")} />
          </>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{t("code.fingerprint")}</p>
              <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(adding)}</p>
              <p className="mt-1 text-xs text-ink-500">{t("account.shouldMatch")}</p>
            </div>
            <Field label={t("account.callThem")}>
              <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
            </Field>
            <p className="text-xs text-ink-400">{t("account.onlyYou")}</p>
            <Button disabled={!newName.trim()} onClick={add}>
              {t("account.addNamed", { name: newName.trim() || t("account.guardian") })}
            </Button>
          </div>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("account.guardians")}
      subtitle={t("account.guardiansSubtitle")}
      footer={
        <>
          {saving.error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{saving.error}</p>}
          <Button className="w-full" loading={saving.busy} disabled={unchanged} onClick={save}>
            {t("account.saveGuardians")}
          </Button>
        </>
      }
    >
      <ul className="mb-3 flex flex-col gap-2">
        {guardians.map((g) => (
          <li key={bytesToHex(g)} className="flex items-center gap-3 rounded-2xl border border-ink-100 p-3 dark:border-ink-800">
            <Users size={16} className="text-ink-400" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{names[encodeHashToBase64(g)] || t("account.guardianCap")}</span>
              <span className="block font-mono text-xs text-ink-400">{keyFingerprint(g)}</span>
            </span>
            <button
              type="button"
              aria-label={t("common.remove")}
              onClick={() => {
                const next = guardians.filter((x) => !bytesEqual(x, g));
                setGuardians(next);
                setThreshold(Math.max(1, Math.min(threshold, next.length)));
              }}
              className="text-ink-300 hover:text-red-500"
            >
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
      {guardians.length < MAX_GUARDIANS && (
        <Button variant="ghost" className="w-full" onClick={() => setAdding("scan")}>
          <UserPlus size={16} /> {t("account.addGuardian")}
        </Button>
      )}
      {guardians.length > 0 && (
        <Field label={t("account.howMany")} className="mt-4">
          <Select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
            {guardians.map((_, i) => (
              <option key={i} value={i + 1}>
                {t("account.ofCount", { n: i + 1, count: guardians.length })}
                {i + 1 > guardians.length / 2 ? "" : ` ${t("account.fewerThanHalf")}`}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <p className="mt-3 text-xs leading-relaxed text-ink-400">
        {t("account.pickPeople")}
      </p>
    </Sheet>
  );
}
