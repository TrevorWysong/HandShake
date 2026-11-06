// A customer's own allergies: what their app flags on menus, and offers to tell
// a store at checkout. Sealed to them on the network, so they move with the
// account and nobody can read them.
import { useState } from "react";
import { HeartPulse } from "lucide-react";
import { saveMyAllergies } from "../../holochain/zomes/profiles";
import type { AllergySet } from "../../holochain/types";
import { MAX_LABEL_CHARS } from "../../holochain/types";
import { useAction } from "../../lib/hooks/useAction";
import { useMyAllergies } from "../../lib/hooks/useMyAllergies";
import { parseAllergenWords } from "../../lib/storefront/allergens";
import { useT } from "../../i18n";
import { InfoSheet } from "../InfoSheet";
import { AllergenSetPicker } from "../store/Allergens";
import { Button, Card, Input, Notice, SectionLabel, Skeleton } from "../ui";

export function MyAllergies() {
  const t = useT();
  const { mine, loaded, reload } = useMyAllergies();
  const sections = (["where", "match", "limits"] as const).map((part) => ({ title: t(`myAllergies.why.${part}`), body: t(`myAllergies.why.${part}Detail`) }));
  return (
    <Card className="mb-4 p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <SectionLabel icon={<HeartPulse size={13} />}>{t("myAllergies.title")}</SectionLabel>
        <InfoSheet title={t("myAllergies.how")} sections={sections} />
      </div>
      <p className="mb-3 text-xs text-ink-400">{t("myAllergies.detail")}</p>
      {loaded ? <AllergyForm key={JSON.stringify(mine)} mine={mine} onSaved={reload} /> : <Skeleton className="h-24 w-full" />}
    </Card>
  );
}

function AllergyForm({ mine, onSaved }: { mine: AllergySet; onSaved: () => Promise<void> }) {
  const t = useT();
  const [allergens, setAllergens] = useState(mine.allergens);
  const [words, setWords] = useState(mine.other.join(", "));
  const saving = useAction();
  const next: AllergySet = { allergens, other: parseAllergenWords(words) };
  const changed = JSON.stringify([[...next.allergens].sort(), next.other]) !== JSON.stringify([[...mine.allergens].sort(), mine.other]);
  const tooLong = next.other.some((word) => word.length > MAX_LABEL_CHARS);
  const save = () => saving.run(async () => {
    await saveMyAllergies(next);
    await onSaved();
  });
  return (
    <>
      <AllergenSetPicker value={allergens} onChange={setAllergens} label={t("myAllergies.title")} />
      <Input className="mt-3" value={words} onChange={(e) => setWords(e.target.value)} placeholder={t("myAllergies.other")} aria-label={t("myAllergies.other")} />
      {changed && <p className="mt-3 text-xs leading-relaxed text-ink-500">{t("myAllergies.consent")}</p>}
      {changed && <Button className="mt-3 w-full py-2 text-sm" disabled={tooLong} loading={saving.busy} onClick={save}>{t("myAllergies.save")}</Button>}
      {saving.error && <Notice className="mt-2">{saving.error}</Notice>}
    </>
  );
}
