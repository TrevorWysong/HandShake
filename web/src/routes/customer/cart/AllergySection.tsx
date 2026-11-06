// Allergies at checkout: whether to tell this store the customer's, what this
// store says it can do with them, and whatever in the cart meets them. Off by
// nobody's default but theirs; never sent anywhere but sealed to this store.
import { useState } from "react";
import { Link } from "react-router-dom";
import { HeartPulse } from "lucide-react";
import type { AllergyPolicy, AllergySet } from "../../../holochain/types";
import { Input, Switch } from "../../../components/ui";
import { AllergenSetPicker, AllergyWarning } from "../../../components/store/Allergens";
import { useAllergenNames } from "../../../lib/hooks/useAllergenNames";
import { InfoSheet } from "../../../components/InfoSheet";
import { hasAllergies, parseAllergenWords } from "../../../lib/storefront/allergens";
import type { CartAllergyMatch } from "./useCartAllergies";
import { useT } from "../../../i18n";
import { Section } from "./CartPieces";

export function AllergySection({ mine, telling, onTell, allergies, onAllergies, policy, storeName, matches }: { mine: AllergySet; telling: boolean; onTell: (tell: boolean) => void; allergies: AllergySet; onAllergies: (next: AllergySet) => void; policy: AllergyPolicy | null; storeName: string; matches: CartAllergyMatch[] }) {
  const t = useT();
  const names = useAllergenNames();
  const [editing, setEditing] = useState(false);
  const [words, setWords] = useState(allergies.other.join(", "));
  const notAccepted = policy?.requests === "NotAccepted";
  const straightToKitchen = !!policy?.auto_accept_requests;
  const sections = (["who", "read", "trust"] as const).map((part) => ({ title: t(`cart.allergy.why.${part}`), body: t(`cart.allergy.why.${part}Detail`) }));
  const summary = [names(allergies.allergens), ...allergies.other].filter(Boolean).join(", ");
  return (
    <Section title={t("cart.allergy.title")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink-900 dark:text-ink-50">
            <HeartPulse size={15} className="text-handshake-500" /> {t("cart.allergy.tell", { store: storeName })}
            <InfoSheet title={t("cart.allergy.how")} sections={sections} />
          </p>
          <p className="mt-0.5 text-xs text-ink-500">{telling && summary ? summary : hasAllergies(mine) ? t("cart.allergy.notTelling") : t("cart.allergy.none")}</p>
        </div>
        <Switch checked={telling} onChange={onTell} label={t("cart.allergy.tell", { store: storeName })} />
      </div>

      {telling && (
        <button type="button" onClick={() => setEditing((was) => !was)} className="mt-2 text-xs font-semibold text-handshake-600 dark:text-handshake-400">
          {t(editing ? "cart.allergy.done" : "cart.allergy.change")}
        </button>
      )}
      {telling && editing && (
        <div className="mt-2 flex flex-col gap-2">
          <AllergenSetPicker value={allergies.allergens} onChange={(allergens) => onAllergies({ ...allergies, allergens })} label={t("cart.allergy.title")} />
          <Input
            value={words}
            onChange={(e) => {
              setWords(e.target.value);
              onAllergies({ ...allergies, other: parseAllergenWords(e.target.value) });
            }}
            placeholder={t("myAllergies.other")}
            aria-label={t("myAllergies.other")}
          />
        </div>
      )}
      {!hasAllergies(mine) && !telling && <Link to="/profile" className="mt-2 block text-xs font-semibold text-handshake-600 dark:text-handshake-400">{t("cart.allergy.setUp")}</Link>}

      {telling && notAccepted && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-800 dark:bg-red-950/40 dark:text-red-200">{t("cart.allergy.notAccepted", { store: storeName })}</p>}
      {telling && !notAccepted && <p className="mt-2 text-xs text-ink-500">{t(policy ? `cart.allergy.policy.${policy.requests}` : "cart.allergy.policy.unstated", { store: storeName })} {t(straightToKitchen ? "cart.allergy.onTicket" : "cart.allergy.personReads")}</p>}
      {policy?.note && <p className="mt-1 text-xs italic text-ink-500">{policy.note}</p>}

      {matches.map(({ name, match, bag }) => (
        <div key={name} className="mt-2">
          <p className="mb-1 text-xs font-semibold text-ink-700 dark:text-ink-200">{name}</p>
          {bag ? <p className="rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{t("allergy.bag")}</p> : <AllergyWarning match={match} />}
        </div>
      ))}
    </Section>
  );
}
