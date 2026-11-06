// What a store says of one item or bag: nothing yet, or what's in it, what may
// be, what it can leave out and anything else. One editor, so saying it takes
// the same few taps everywhere, and another item's answer can be reused.
import { useState } from "react";
import clsx from "clsx";
import type { AllergenFacts } from "../../holochain/types";
import { MAX_NOTE_CHARS } from "../../holochain/types";
import { parseAllergenWords } from "../../lib/storefront/allergens";
import { useAllergenName } from "../../lib/hooks/useAllergenNames";
import { useT, type MessageKey } from "../../i18n";
import { Input, Select, Switch, Textarea } from "../ui";
import { AllergenFactsPicker } from "./Allergens";

const NOTHING_SAID: AllergenFacts = { contains: [], may_contain: [], other: [], note: "", can_omit: [] };

export function AllergenFactsEditor({ value, onChange, copyFrom = [], statedDetail = "menuEditor.allergensStated", unstatedDetail = "menuEditor.allergensUnstated", conflicts = [] }: {
  value: AllergenFacts | null;
  onChange: (next: AllergenFacts | null) => void;
  /// Others' answers to start from.
  copyFrom?: { name: string; facts: AllergenFacts }[];
  statedDetail?: MessageKey;
  unstatedDetail?: MessageKey;
  /// Dietary tags this statement contradicts.
  conflicts?: string[];
}) {
  const t = useT();
  const name = useAllergenName();
  const [words, setWords] = useState((value?.other ?? []).join(", "));
  const facts = value ?? NOTHING_SAID;
  const set = (patch: Partial<AllergenFacts>) => onChange({ ...facts, ...patch });
  const copy = (name: string) => {
    const from = copyFrom.find((candidate) => candidate.name === name)?.facts;
    if (!from) return;
    onChange({ ...from });
    setWords(from.other.join(", "));
  };
  return (
    <div className="rounded-xl border border-ink-100 p-3 dark:border-ink-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("menuEditor.allergens")}</p>
          <p className="text-xs text-ink-400">{t(value ? statedDetail : unstatedDetail)}</p>
        </div>
        <Switch checked={!!value} onChange={(on) => onChange(on ? NOTHING_SAID : null)} label={t("menuEditor.allergens")} />
      </div>
      {value && (
        <div className="mt-3 flex flex-col gap-2.5">
          {copyFrom.length > 0 && (
            <Select aria-label={t("menuEditor.allergensCopy")} className="py-1.5 text-xs" value="" onChange={(e) => copy(e.target.value)}>
              <option value="">{t("menuEditor.allergensCopy")}</option>
              {copyFrom.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
            </Select>
          )}
          <AllergenFactsPicker contains={facts.contains} mayContain={facts.may_contain} onChange={(next) => set({ ...next, can_omit: facts.can_omit.filter((a) => next.contains.includes(a)) })} />
          {facts.contains.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">{t("menuEditor.allergensOmit")}</p>
              <div className="flex flex-wrap gap-1.5">
                {facts.contains.map((allergen) => {
                  const on = facts.can_omit.includes(allergen);
                  return (
                    <button key={allergen} type="button" aria-pressed={on} onClick={() => set({ can_omit: on ? facts.can_omit.filter((a) => a !== allergen) : [...facts.can_omit, allergen] })} className={clsx("rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors", on ? "bg-presence-600 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-300")}>
                      {name(allergen)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <Input
            value={words}
            onChange={(e) => {
              setWords(e.target.value);
              set({ other: parseAllergenWords(e.target.value) });
            }}
            placeholder={t("menuEditor.allergensOther")}
            aria-label={t("menuEditor.allergensOther")}
          />
          <Textarea maxLength={MAX_NOTE_CHARS} rows={2} value={facts.note} onChange={(e) => set({ note: e.target.value })} placeholder={t("menuEditor.allergensNote")} aria-label={t("menuEditor.allergensNote")} />
          {conflicts.length > 0 && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{t("menuEditor.allergensConflict", { tags: conflicts.join(", ") })}</p>}
        </div>
      )}
    </div>
  );
}
