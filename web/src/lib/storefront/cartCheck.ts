// A cart checked against its store as it is now: what was added may since
// have been repriced, taken off the menu, sold out, had its choices changed,
// or -- a goodie bag -- been ended by its store. Checkout says so on each
// line before the order is placed, and reprices what only changed in price,
// so the order sent is one the network accepts at the total the customer
// saw. The network checks it all again (dispatch `pricing::price_order`).
import { bytesEqual, bytesToHex } from "../../holochain/decode";
import type { CartLine } from "../../store/cart";
import { t } from "../../i18n";
import { emptySelections, linePrice, type Groups } from "./choices";
import type { MenuItem, SelectionInput } from "../../holochain/types";
import type { ItemRow } from "./menu";

export type LineCheck =
  /// As it was added.
  | { kind: "ok" }
  /// Its choices still fit; only what it costs changed. The line as it
  /// costs now.
  | { kind: "repriced"; line: CartLine }
  /// It can't be ordered any more: take it out.
  | { kind: "gone"; reason: string }
  /// Its choices no longer fit the item: choose again.
  | { kind: "choose"; reason: string }
  /// What it's checked against couldn't be read: not known to be fine, so
  /// the order waits while it's read again.
  | { kind: "unchecked" };

/// `line` against the store's menu (`menu`, as sold now: sale prices
/// applied), its choice groups at their latest, and the goodie bags it has
/// on offer (`liveBags`, original actions in hex). Any of them `null` --
/// couldn't be read -- leaves what depends on it `unchecked`, never passed.
export function checkLine(line: CartLine, menu: readonly ItemRow[] | null, groups: Groups | null, liveBags: ReadonlySet<string> | null): LineCheck {
  if (line.bag) {
    if (liveBags === null) return { kind: "unchecked" };
    return liveBags.has(bytesToHex(line.itemRef)) ? { kind: "ok" } : { kind: "gone", reason: t("cart.check.bagEnded") };
  }
  if (menu === null || groups === null) return { kind: "unchecked" };
  const row = menu.find((candidate) => bytesEqual(candidate.hash, line.itemRef));
  if (!row) return { kind: "gone", reason: t("cart.check.removed") };
  if (!row.item.available) return { kind: "gone", reason: t("cart.check.soldOut") };
  const priced = linePrice(row.item, line.selections, groups);
  if (!priced.ok) return { kind: "choose", reason: priced.reason };
  // A reward's line is free whatever it's worth: only its being there counts.
  if (line.rewardId != null) return { kind: "ok" };
  if (priced.price === line.priceCents && row.item.price_cents === line.basePriceCents) return { kind: "ok" };
  return { kind: "repriced", line: { ...line, basePriceCents: row.item.price_cents, priceCents: priced.price, choiceCharges: priced.choices } };
}

/// A line's choices to choose again from: what still fits kept, what doesn't
/// let go -- an option no longer on offer is unchosen, and an item whose
/// groups changed starts afresh -- so choosing again starts from what the
/// customer had, not from what the store has dropped.
export function choicesToKeep(item: MenuItem, selections: SelectionInput[], groups: Groups): SelectionInput[] {
  const sameGroups = selections.length === item.modifier_groups.length && selections.every((selection, i) => bytesEqual(selection.group, item.modifier_groups[i]));
  if (!sameGroups) return emptySelections(item.modifier_groups);
  return selections.map((selection) => {
    const group = groups.get(bytesToHex(selection.group));
    return { ...selection, options: group ? selection.options.filter((chosen) => group.options.some((option) => option.id === chosen.option && option.available)) : [] };
  });
}
