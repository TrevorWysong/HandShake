// What a store says about allergens across its kitchen, and how it takes a
// customer's requests. Its own word, shown to customers as that.
import { useState } from "react";
import { setAllergyPolicy } from "../../../holochain/zomes/catalog";
import type { AllergyPolicy, AllergyRequests, MerchantCatalog } from "../../../holochain/types";
import { MAX_NOTE_CHARS } from "../../../holochain/types";
import { InfoSheet } from "../../../components/InfoSheet";
import { AllergenSetPicker } from "../../../components/store/Allergens";
import { Button, Card, Field, Input, Notice, SectionLabel, Select, Switch, Textarea } from "../../../components/ui";
import { useAction } from "../../../lib/hooks/useAction";
import { parseAllergenWords } from "../../../lib/storefront/allergens";
import { useT } from "../../../i18n";

const REQUESTS: AllergyRequests[] = ["Welcome", "BestEffort", "NotAccepted"];

export function AllergyPolicyCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const t = useT();
  const current = catalog.allergy_policy ?? null;
  const [stated, setStated] = useState(current !== null);
  const [kitchen, setKitchen] = useState(current?.kitchen ?? []);
  const [words, setWords] = useState((current?.other ?? []).join(", "));
  const [requests, setRequests] = useState<AllergyRequests>(current?.requests ?? "BestEffort");
  const [note, setNote] = useState(current?.note ?? "");
  const [autoAccept, setAutoAccept] = useState(current?.auto_accept_requests ?? false);
  const saving = useAction();
  const sections = (["word", "kitchen", "requests", "items"] as const).map((part) => ({ title: t(`allergyPolicy.why.${part}`), body: t(`allergyPolicy.why.${part}Detail`) }));
  const save = () => saving.run(async () => {
    const policy: AllergyPolicy | null = stated ? { kitchen, other: parseAllergenWords(words), requests, note: note.trim(), auto_accept_requests: autoAccept && requests !== "NotAccepted" } : null;
    await setAllergyPolicy(catalogRef, policy);
    await onSaved();
  });
  return (
    <Card className="mb-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-1.5">
            <SectionLabel>{t("allergyPolicy.title")}</SectionLabel>
            <InfoSheet title={t("allergyPolicy.how")} sections={sections} />
          </div>
          <p className="text-xs text-ink-400">{t("allergyPolicy.detail")}</p>
        </div>
        <Switch checked={stated} onChange={setStated} label={t("allergyPolicy.title")} />
      </div>
      {stated && (
        <div className="mt-4 flex flex-col gap-3">
          <Field label={t("allergyPolicy.requests")}>
            <Select value={requests} onChange={(e) => setRequests(e.target.value as AllergyRequests)}>
              {REQUESTS.map((choice) => <option key={choice} value={choice}>{t(`allergyPolicy.requests.${choice}`)}</option>)}
            </Select>
          </Field>
          {requests !== "NotAccepted" && catalog.auto_accept_orders && (
            <label className="flex items-start justify-between gap-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-800/50">
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink-900 dark:text-ink-50">{t("allergyPolicy.autoAccept")}</span>
                <span className="block text-xs text-ink-400">{t(autoAccept ? "allergyPolicy.autoAcceptOn" : "allergyPolicy.autoAcceptOff")}</span>
              </span>
              <Switch checked={autoAccept} onChange={setAutoAccept} label={t("allergyPolicy.autoAccept")} />
            </label>
          )}
          <Field label={t("allergyPolicy.kitchen")}>
            <AllergenSetPicker value={kitchen} onChange={setKitchen} label={t("allergyPolicy.kitchen")} />
          </Field>
          <Input value={words} onChange={(e) => setWords(e.target.value)} placeholder={t("allergyPolicy.other")} aria-label={t("allergyPolicy.other")} />
          <Textarea maxLength={MAX_NOTE_CHARS} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("allergyPolicy.note")} aria-label={t("allergyPolicy.note")} />
        </div>
      )}
      <Button variant="secondary" className="mt-3 w-full py-2 text-sm" loading={saving.busy} onClick={save}>{t("allergyPolicy.save")}</Button>
      {saving.error && <Notice className="mt-2">{saving.error}</Notice>}
    </Card>
  );
}
