import { useMemo } from "react";
import { getModifierGroups, listGoodieBagsForCatalog } from "../../../holochain/zomes/catalog";
import { bytesEqual, bytesToHex, decodeEntry } from "../../../holochain/decode";
import type { ActionHash, AllergyPolicy, AllergySet, GoodieBag, ModifierGroup } from "../../../holochain/types";
import type { CartLine } from "../../../store/cart";
import { useResource } from "../../../lib/hooks/useResource";
import { matchAllergies, needsALook } from "../../../lib/storefront/allergens";
import { allergensChosen, missingSelectionGroups, type Groups } from "../../../lib/storefront/choices";
import type { ItemRow } from "../../../lib/storefront/menu";

export interface CartAllergyMatch {
  name: string;
  match: ReturnType<typeof matchAllergies>;
  /// A goodie bag that hasn't said: contents vary.
  bag: boolean;
}

/// The choice groups a cart's lines chose from, and its bags, as they read now
/// -- the order's priced from these, so a warning must read them too.
async function fetchCartStatements(catalogRef: ActionHash, lines: CartLine[]) {
  const groups: Groups = new Map();
  for (let pending = missingSelectionGroups(lines, groups); pending.length > 0; pending = missingSelectionGroups(lines, groups)) {
    const views = await getModifierGroups(catalogRef, pending);
    for (const view of views) groups.set(bytesToHex(view.original_action), decodeEntry<ModifierGroup>(view.record));
    // A group that's gone can't be read again: stop rather than ask forever.
    if (views.length === 0) break;
  }
  const bags = lines.some((line) => line.bag) ? await listGoodieBagsForCatalog(catalogRef) : [];
  return { groups, bags: bags.map((view) => ({ hash: view.original_action, bag: decodeEntry<GoodieBag>(view.record) })) };
}

/// Where someone's allergies meet each line of a cart, its choices included.
export function useCartAllergies(catalogRef: ActionHash | null, lines: CartLine[], menuItems: ItemRow[], policy: AllergyPolicy | null, allergies: AllergySet): CartAllergyMatch[] {
  const key = catalogRef && lines.length > 0 ? `cart-allergens:${bytesToHex(catalogRef)}:${lines.map((line) => JSON.stringify([bytesToHex(line.itemRef), line.choiceLabels])).join("|")}` : null;
  const { data } = useResource(key, () => fetchCartStatements(catalogRef!, lines));
  return useMemo(() => lines.flatMap((line): CartAllergyMatch[] => {
    if (line.bag) {
      const facts = data?.bags.find((row) => bytesEqual(row.hash, line.itemRef))?.bag.allergens;
      const match = matchAllergies(facts, policy, allergies);
      return needsALook(match) ? [{ name: line.name, match, bag: !facts }] : [];
    }
    const row = menuItems.find((candidate) => bytesEqual(candidate.hash, line.itemRef));
    if (!row) return [];
    const match = matchAllergies(row.item.allergens, policy, allergies, data ? allergensChosen(line.selections, data.groups) : undefined);
    return needsALook(match) ? [{ name: line.name, match, bag: false }] : [];
  }), [lines, menuItems, policy, allergies, data]);
}
