// Menu item choices -- sizes, add-ons, sides -- on the customer's side: what
// a line costs with its choices, whether they're complete, how they read,
// and how picking an option changes them. The pricing mirrors
// `catalog_types::modifiers::line_price`, which validation enforces, so the
// running price on the item sheet is what the order is charged; both are
// tested on the same cases (web/test/choices.test.ts).
import type { ActionHash, ChoiceTerms, ChosenInput, MenuItem, ModifierGroup, SelectionInput } from "../../holochain/types";
import { MAX_CHOICE_DEPTH, MAX_LINE_CHOICES } from "../../holochain/types";
import { bytesEqual, bytesToHex } from "../../holochain/decode";
import { t } from "../../i18n";

/// A store's choice groups at their latest, by original action (hex).
export type Groups = Map<string, ModifierGroup>;

/// What a line's chosen options in one of its item's groups add to a unit
/// of it, unit by unit -- after the group's free selections, with what each
/// opened (`catalog_types::GroupCharges`): what an item reward covers.
export interface GroupCharges {
  /// The group's original action, hex.
  group: string;
  units: { option: number; cents: number }[];
}

export type Priced = { ok: true; price: number; choices: GroupCharges[] } | { ok: false; reason: string };
type Failed = { ok: false; reason: string };

/// What one unit of `item` costs with `selections`, or why they don't fit
/// -- one per item group in order, options ascending and on offer, each
/// group's count within its bounds, nested groups answered, the cheapest
/// `free_selections` of each group free.
export function linePrice(item: MenuItem, selections: SelectionInput[], groups: Groups): Priced {
  const budget = { left: MAX_LINE_CHOICES };
  const choices = priceSelections(item.modifier_groups, selections, groups, 1, budget);
  return choices.ok ? { ok: true, price: item.price_cents + costOf(choices.groups), choices: choices.groups } : choices;
}

const costOf = (groups: GroupCharges[]) => groups.reduce((sum, g) => sum + g.units.reduce((n, u) => n + u.cents, 0), 0);

function priceSelections(refs: ActionHash[], selections: SelectionInput[], groups: Groups, depth: number, budget: { left: number }): { ok: true; groups: GroupCharges[] } | Failed {
  if (selections.length !== refs.length || selections.some((s, i) => !bytesEqual(s.group, refs[i]))) {
    return { ok: false, reason: t("choices.chooseEach") };
  }
  const charges: GroupCharges[] = [];
  for (const selection of selections) {
    const key = bytesToHex(selection.group);
    const group = groups.get(key);
    if (!group) return { ok: false, reason: t("choices.changed") };
    const priced = priceGroup(group, selection, groups, depth, budget);
    if (!priced.ok) return priced;
    charges.push({ group: key, units: priced.units });
  }
  return { ok: true, groups: charges };
}

function priceGroup(group: ModifierGroup, selection: SelectionInput, groups: Groups, depth: number, budget: { left: number }): { ok: true; units: GroupCharges["units"] } | Failed {
  // Each unit chosen: its option, its price, and what it opened.
  const units: { option: number; price: number; opened: number }[] = [];
  let previous = -1;
  for (const chosen of selection.options) {
    if (chosen.option <= previous) return { ok: false, reason: t("choices.once", { group: group.name }) };
    previous = chosen.option;
    if (budget.left === 0) return { ok: false, reason: t("choices.atMost", { count: MAX_LINE_CHOICES }) };
    budget.left -= 1;
    const option = group.options.find((o) => o.id === chosen.option && o.available);
    if (!option) return { ok: false, reason: t("choices.gone", { group: group.name }) };
    if (chosen.quantity < 1 || chosen.quantity > group.max_per_option) return { ok: false, reason: t("choices.perOption", { option: option.name, max: group.max_per_option }) };
    let opened = 0;
    if (option.nested_group) {
      if (depth >= MAX_CHOICE_DEPTH) return { ok: false, reason: t("choices.tooDeep") };
      const nested = priceSelections([option.nested_group], chosen.nested, groups, depth + 1, budget);
      if (!nested.ok) return nested;
      opened = costOf(nested.groups);
    } else if (chosen.nested.length > 0) {
      return { ok: false, reason: t("choices.nothingMore", { option: option.name }) };
    }
    for (let i = 0; i < chosen.quantity; i++) units.push({ option: option.id, price: option.price_cents, opened });
  }
  const count = units.length;
  if (count < group.min_selections || (group.max_selections !== null && count > group.max_selections)) {
    return { ok: false, reason: t("choices.range", { group: group.name, range: rangeLabel(group) }) };
  }
  // The cheapest free -- by price, then option, as validation picks them.
  units.sort((a, b) => a.price - b.price || a.option - b.option);
  return { ok: true, units: units.map((u, i) => ({ option: u.option, cents: (i < group.free_selections ? 0 : u.price) + u.opened })) };
}

/// "Choose 1", "Choose up to 3", "Choose 2 to 4" -- what a group asks for.
/// `groups` with only the options `terms` allow, in the groups they name:
/// what a reward's item can be chosen with.
export function within(groups: Groups, terms: ChoiceTerms[]): Groups {
  const shown = new Map(groups);
  for (const term of terms) {
    const key = bytesToHex(term.group);
    const group = groups.get(key);
    if (group && term.options.length > 0) shown.set(key, { ...group, options: group.options.filter((o) => term.options.includes(o.id)) });
  }
  return shown;
}

export function rangeLabel(group: ModifierGroup): string {
  const { min_selections: min, max_selections: max } = group;
  if (max !== null && min === max) return t("choices.exactly", { count: max });
  if (min === 0) return max === null ? t("choices.any") : t("choices.upTo", { count: max });
  return max === null ? t("choices.atLeast", { count: min }) : t("choices.between", { min, max });
}

/// Whether a group takes one option only -- shown as radio buttons.
export function isSingleChoice(group: ModifierGroup): boolean {
  return group.max_selections === 1 && group.max_per_option === 1;
}

/// A fresh, empty answer for each of `refs`.
export function emptySelections(refs: ActionHash[]): SelectionInput[] {
  return refs.map((group) => ({ group, options: [] }));
}

/// `selection` with `optionId` chosen `quantity` times (0 removes it) --
/// replacing the choice in a single-choice group, opening an empty answer
/// for the option's nested group, and keeping options ascending.
export function choose(selection: SelectionInput, group: ModifierGroup, optionId: number, quantity: number): SelectionInput {
  const option = group.options.find((o) => o.id === optionId);
  if (!option) return selection;
  const existing = selection.options.find((c) => c.option === optionId);
  const kept = isSingleChoice(group) ? [] : selection.options.filter((c) => c.option !== optionId);
  const next: ChosenInput[] =
    quantity > 0 ? [...kept, { option: optionId, quantity, nested: existing?.nested ?? (option.nested_group ? emptySelections([option.nested_group]) : []) }] : kept;
  return { ...selection, options: next.sort((a, b) => a.option - b.option) };
}

/// `selection` with the nested answer under `optionId` replaced.
export function withNested(selection: SelectionInput, optionId: number, nested: SelectionInput): SelectionInput {
  return { ...selection, options: selection.options.map((c) => (c.option === optionId ? { ...c, nested: [nested] } : c)) };
}

/// Every chosen option, as people read them: "Large", "2 x Extra shot",
/// "Fries (Large)" -- the same wording as the order's lines.
export function choiceLabels(selections: SelectionInput[], groups: Groups): string[] {
  return selections.flatMap((selection) => {
    const group = groups.get(bytesToHex(selection.group));
    return selection.options.map((chosen) => {
      const name = group?.options.find((o) => o.id === chosen.option)?.name ?? "(removed)";
      const label = chosen.quantity > 1 ? `${chosen.quantity} x ${name}` : name;
      const nested = choiceLabels(chosen.nested, groups);
      return nested.length ? `${label} (${nested.join(", ")})` : label;
    });
  });
}

/// The groups an item's sheet needs beyond those already in `groups`: its
/// own, and any its options open, `MAX_CHOICE_DEPTH` levels down.
export function missingGroups(item: MenuItem, groups: Groups): ActionHash[] {
  const missing = new Map<string, ActionHash>();
  let level = item.modifier_groups;
  for (let depth = 1; depth <= MAX_CHOICE_DEPTH && level.length > 0; depth++) {
    const next: ActionHash[] = [];
    for (const ref of level) {
      const group = groups.get(bytesToHex(ref));
      if (!group) missing.set(bytesToHex(ref), ref);
      else next.push(...group.options.flatMap((o) => (o.nested_group ? [o.nested_group] : [])));
    }
    level = next;
  }
  return [...missing.values()];
}

/// A stable key for a set of choices -- two cart lines with the same item
/// and key are one line.
export function selectionsKey(selections: SelectionInput[]): string {
  return selections.map((s) => `${bytesToHex(s.group)}[${s.options.map((c) => `${c.option}x${c.quantity}${c.nested.length ? `{${selectionsKey(c.nested)}}` : ""}`).join(",")}]`).join(";");
}

/// What a store's group form would be refused for, if anything -- the
/// network's rules (`ModifierGroup::problem`), told first.
export function groupProblem(group: ModifierGroup): string | null {
  if (!group.name.trim()) return t("choices.problem.name");
  if (group.options.length === 0) return t("choices.problem.noOptions");
  if (group.options.some((o) => !o.name.trim())) return t("choices.problem.optionName");
  if (new Set(group.options.map((o) => o.id)).size !== group.options.length) return t("choices.problem.ids");
  const most = group.options.length * group.max_per_option;
  if (group.min_selections > most) return t("choices.problem.minTooHigh");
  if (group.max_selections !== null && (group.max_selections < 1 || group.max_selections < group.min_selections || group.max_selections > most)) {
    return t("choices.problem.max");
  }
  if (group.free_selections > (group.max_selections ?? most)) return t("choices.problem.free");
  return null;
}

/// What the options chosen so far say they add, nested ones included.
export function allergensChosen(selections: SelectionInput[], groups: Groups): { contains: string[]; other: string[] } {
  const contains = new Set<string>();
  const other = new Set<string>();
  const walk = (selection: SelectionInput) => {
    const group = groups.get(bytesToHex(selection.group));
    for (const chosen of selection.options) {
      const option = group?.options.find((o) => o.id === chosen.option);
      option?.contains.forEach((a) => contains.add(a));
      option?.other_allergens.forEach((word) => other.add(word));
      chosen.nested.forEach(walk);
    }
  };
  selections.forEach(walk);
  return { contains: [...contains], other: [...other] };
}

/// The groups a cart's lines chose from, nested ones too, not yet read.
export function missingSelectionGroups(lines: { selections: SelectionInput[] }[], groups: Groups): ActionHash[] {
  const missing = new Map<string, ActionHash>();
  const walk = (selection: SelectionInput) => {
    const hex = bytesToHex(selection.group);
    if (!groups.has(hex)) missing.set(hex, selection.group);
    selection.options.forEach((chosen) => chosen.nested.forEach(walk));
  };
  lines.forEach((line) => line.selections.forEach(walk));
  return [...missing.values()];
}
