import { ALLERGENS, type Allergen } from "../storefront/allergens";
import { useT, type MessageKey } from "../../i18n";

/// An allergen's name in the reader's language. One this app doesn't know yet
/// shows as the store wrote it: an allergen must never go unread.
export function useAllergenName(): (allergen: Allergen) => string {
  const t = useT();
  return (allergen) => (ALLERGENS.includes(allergen) ? t(`allergen.${allergen}` as MessageKey) : allergen);
}

/// Allergens' names, as a list.
export function useAllergenNames(): (allergens: readonly Allergen[]) => string {
  const name = useAllergenName();
  return (allergens) => allergens.map(name).join(", ");
}
