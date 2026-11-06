// How allergens read everywhere: what a store says of an item, what a kitchen
// says of itself, what meets someone's own allergies, and the pickers a store
// and a customer say them with.
import clsx from "clsx";
import { AlertTriangle, ShieldQuestion } from "lucide-react";
import type { AllergenFacts, AllergyPolicy, AllergySet } from "../../holochain/types";
import { ALLERGENS, hasMatch, type Allergen, type AllergyMatch } from "../../lib/storefront/allergens";
import { useAllergenName, useAllergenNames } from "../../lib/hooks/useAllergenNames";
import { useT } from "../../i18n";

/// One line of a statement: what it's about, and what's said.
function Said({ label, text, urgent }: { label: string; text: string; urgent?: boolean }) {
  return (
    <p className={clsx("text-xs leading-relaxed", urgent ? "font-semibold text-red-700 dark:text-red-300" : "text-ink-600 dark:text-ink-300")}>
      <span className="font-semibold">{label}</span> {text}
    </p>
  );
}

/// Where someone's allergies meet an item, in the words that matter to them.
export function AllergyWarning({ match, className, announce = false }: { match: AllergyMatch; className?: string; announce?: boolean }) {
  const t = useT();
  const names = useAllergenNames();
  if (!hasMatch(match) && !match.notStated) return null;
  const contains = [names(match.contains), ...match.containsOther].filter(Boolean).join(", ");
  const may = [names(match.mayContain), ...match.mayContainOther].filter(Boolean).join(", ");
  return (
    <div role={announce ? "alert" : undefined} className={clsx("flex items-start gap-2 rounded-xl p-3", contains ? "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200" : "bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200", className)}>
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <div className="min-w-0 text-xs leading-relaxed">
        {contains && <p className="font-bold">{t("allergy.warn.contains", { allergens: contains })}</p>}
        {may && <p className={contains ? "" : "font-bold"}>{t("allergy.warn.may", { allergens: may })}</p>}
        {match.notStated && <p className="font-bold">{t("allergy.warn.notStated")}</p>}
      </div>
    </div>
  );
}

/// All a store's said of an item, or that it hasn't. Beside whatever its
/// choices add, and always as the store's own word.
export function AllergenStatement({ facts, policy, added, goodieBag, quiet = false }: { facts: AllergenFacts | null | undefined; policy?: AllergyPolicy | null; added?: { contains: Allergen[]; other: string[] }; goodieBag?: boolean; /** Part of a list that says whose word it is once, itself. */ quiet?: boolean }) {
  const t = useT();
  const names = useAllergenNames();
  if (goodieBag && !facts) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200">
        <ShieldQuestion size={14} className="mt-px shrink-0" /> {t("allergy.bag")}
      </p>
    );
  }
  const addedText = [names(added?.contains ?? []), ...(added?.other ?? [])].filter(Boolean).join(", ");
  const kitchen = [names(policy?.kitchen ?? []), ...(policy?.other ?? [])].filter(Boolean).join(", ");
  const inIt = facts ? [names(facts.contains), ...facts.other].filter(Boolean).join(", ") : "";
  const may = facts ? names(facts.may_contain) : "";
  const omit = facts ? names(facts.can_omit) : "";
  return (
    <div className="flex flex-col gap-1">
      {!facts && <p className="flex items-start gap-1.5 text-xs font-semibold text-ink-600 dark:text-ink-300"><ShieldQuestion size={14} className="mt-px shrink-0" /> {t("allergy.notStated")}</p>}
      {facts && !inIt && !may && <Said label={t("allergy.saysNone")} text="" />}
      {inIt && <Said label={t("allergy.contains")} text={inIt} />}
      {may && <Said label={t("allergy.mayContain")} text={may} />}
      {omit && <Said label={t("allergy.canOmit")} text={omit} />}
      {addedText && <Said label={t("allergy.yourChoicesAdd")} text={addedText} />}
      {kitchen && <Said label={t("allergy.kitchen")} text={kitchen} />}
      {facts?.note && <p className="text-xs italic text-ink-500">{facts.note}</p>}
      {!quiet && <p className="mt-0.5 text-[11px] text-ink-400">{t("allergy.storesWord")}</p>}
    </div>
  );
}

/// A customer's allergies, as told to a store, loud: this is what a kitchen
/// must not miss.
export function AllergyRequest({ allergies, heading }: { allergies: AllergySet; heading: string }) {
  const names = useAllergenNames();
  const text = [names(allergies.allergens), ...allergies.other].filter(Boolean).join(", ");
  if (!text) return null;
  return (
    <div className="mt-2 flex items-start gap-2 rounded-xl bg-red-600 p-3 text-white">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <p className="min-w-0 text-sm leading-snug">
        <span className="block text-[11px] font-bold tracking-wide uppercase opacity-90">{heading}</span>
        <span className="font-bold">{text}</span>
      </p>
    </div>
  );
}

const CHIP = "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors";
const OFF = "bg-ink-100 text-ink-600 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700";

/// Picks a set: for someone's own allergies, a kitchen's, a choice's.
export function AllergenSetPicker({ value, onChange, label }: { value: Allergen[]; onChange: (next: Allergen[]) => void; label: string }) {
  const name = useAllergenName();
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {[...ALLERGENS, ...value.filter((code) => !ALLERGENS.includes(code))].map((allergen) => {
        const on = value.includes(allergen);
        return (
          <button key={allergen} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((a) => a !== allergen) : [...value, allergen])} className={clsx(CHIP, on ? "bg-handshake-500 text-white" : OFF)}>
            {name(allergen)}
          </button>
        );
      })}
    </div>
  );
}

/// Says of an item what's in it and what may be: each tap moves an allergen on
/// from not in it, to in it, to may be.
export function AllergenFactsPicker({ contains, mayContain, onChange }: { contains: Allergen[]; mayContain: Allergen[]; onChange: (next: { contains: Allergen[]; may_contain: Allergen[] }) => void }) {
  const t = useT();
  const name = useAllergenName();
  const next = (allergen: Allergen) => {
    const rest = { contains: contains.filter((a) => a !== allergen), may_contain: mayContain.filter((a) => a !== allergen) };
    if (contains.includes(allergen)) return { ...rest, may_contain: [...rest.may_contain, allergen] };
    if (mayContain.includes(allergen)) return rest;
    return { ...rest, contains: [...rest.contains, allergen] };
  };
  return (
    <div>
      <div role="group" aria-label={t("menuEditor.allergens")} className="flex flex-wrap gap-1.5">
        {ALLERGENS.map((allergen) => {
          const inIt = contains.includes(allergen);
          const may = mayContain.includes(allergen);
          const label = name(allergen);
          return (
            <button key={allergen} type="button" aria-label={`${label}: ${t(inIt ? "allergy.contains" : may ? "allergy.mayContain" : "allergy.notIn")}`} onClick={() => onChange(next(allergen))} className={clsx(CHIP, inIt ? "bg-red-600 text-white" : may ? "bg-amber-400 text-amber-950" : OFF)}>
              {label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-400">
        <span>{t("menuEditor.allergensTap")}</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-600" /> {t("allergy.contains")}</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" /> {t("allergy.mayContain")}</span>
      </p>
    </div>
  );
}
