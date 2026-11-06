// Reading allergens: what a store says against what a customer's told their
// app, on their own device, so the network never learns what they looked for.
// A store's word is all this has, and silence never reads as safe.
import type { AllergenFacts, AllergyPolicy, AllergySet } from "../../holochain/types";
import { MAX_ALLERGEN_LABELS } from "../../holochain/types";

/// An allergen, by its code.
export type Allergen = string;

/// The list, as people pick from it: the ones most people mean, first. The US
/// and EU required lists together, wheat and gluten apart. The network checks
/// only a code's shape, so a list that grows (a new region's) is this one, and
/// every word for it in `i18n`.
export const ALLERGENS: readonly Allergen[] = ["Peanuts", "TreeNuts", "Milk", "Eggs", "Wheat", "Gluten", "Soy", "Fish", "Crustaceans", "Molluscs", "Sesame", "Celery", "Mustard", "Sulphites", "Lupin"];

export const NO_ALLERGIES: AllergySet = { allergens: [], other: [] };

export const hasAllergies = (mine: AllergySet): boolean => mine.allergens.length > 0 || mine.other.length > 0;

/// Comma-separated words as typed, tidied, each once and within the limit.
export function parseAllergenWords(typed: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of typed.split(",").map((w) => w.trim()).filter(Boolean)) {
    const key = word.toLowerCase();
    if (!seen.has(key)) words.push(word);
    seen.add(key);
  }
  return words.slice(0, MAX_ALLERGEN_LABELS);
}

const sameWord = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/// Where someone's allergies meet an item, each named thing once, worst first.
export interface AllergyMatch {
  contains: Allergen[];
  /// May meet it, in this item or the store's kitchen.
  mayContain: Allergen[];
  containsOther: string[];
  mayContainOther: string[];
  /// The store hasn't said, for someone with something to look out for.
  notStated: boolean;
}

export function matchAllergies(facts: AllergenFacts | null | undefined, policy: AllergyPolicy | null | undefined, mine: AllergySet, added: { contains: Allergen[]; other: string[] } = { contains: [], other: [] }): AllergyMatch {
  const contains = mine.allergens.filter((a) => facts?.contains.includes(a) || added.contains.includes(a));
  const mayContain = mine.allergens.filter((a) => !contains.includes(a) && (facts?.may_contain.includes(a) || policy?.kitchen.includes(a)));
  // A store's own words say only "in it, or it may be": read as the first, the safer.
  const containsOther = mine.other.filter((word) => [...(facts?.other ?? []), ...added.other].some((said) => sameWord(said, word)));
  const mayContainOther = mine.other.filter((word) => !containsOther.includes(word) && (policy?.other ?? []).some((said) => sameWord(said, word)));
  return { contains, mayContain, containsOther, mayContainOther, notStated: hasAllergies(mine) && !facts };
}

export const hasMatch = (match: AllergyMatch): boolean => match.contains.length > 0 || match.mayContain.length > 0 || match.containsOther.length > 0 || match.mayContainOther.length > 0;

/// Whether it's worth pausing over before it goes in the cart.
export const needsALook = (match: AllergyMatch): boolean => hasMatch(match) || match.notStated;

/// A dietary tag that what the store says about the same item contradicts: a
/// tag is its own free text, and the statement is what someone relies on.
const TAG_RULES: [RegExp, Allergen[]][] = [
  [/gluten[- ]?free|sin gluten/i, ["Gluten", "Wheat"]],
  [/wheat[- ]?free|sin trigo/i, ["Wheat"]],
  [/dairy[- ]?free|milk[- ]?free|sin l[aá]cteos|sin lactosa/i, ["Milk"]],
  [/egg[- ]?free|sin huevo/i, ["Eggs"]],
  [/(tree[- ]?)?nut[- ]?free|sin frutos secos/i, ["TreeNuts", "Peanuts"]],
  [/peanut[- ]?free|sin cacahuetes?/i, ["Peanuts"]],
  [/soy[- ]?free|sin soja/i, ["Soy"]],
  [/\bvegan[oa]?\b/i, ["Milk", "Eggs", "Fish", "Crustaceans", "Molluscs"]],
  [/\bvegetarian[oa]?\b/i, ["Fish", "Crustaceans", "Molluscs"]],
];

export function tagConflict(tag: string, facts: AllergenFacts | null | undefined): boolean {
  if (!facts) return false;
  return TAG_RULES.some(([rule, allergens]) => rule.test(tag) && allergens.some((a) => facts.contains.includes(a)));
}

/// An item's tags, less any its own statement contradicts.
export const honestTags = (tags: readonly string[], facts: AllergenFacts | null | undefined): string[] => tags.filter((tag) => !tagConflict(tag, facts));
