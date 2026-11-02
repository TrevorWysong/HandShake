// Goodie bags in the cart: a bag as a cart line, and the bags an order
// can't have as it stands -- what checkout says, the network's own rules
// (`dispatch_integrity::checks::bag_line_problem`).
import type { GoodieBag } from "../../holochain/types";
import type { CartLine } from "../../store/cart";

export interface BagRow {
  hash: Uint8Array;
  bag: GoodieBag;
}

/// A goodie bag as a line in the cart: one of it, at its price.
export function bagLine({ hash, bag }: BagRow): CartLine {
  return {
    itemRef: hash,
    name: bag.title,
    basePriceCents: bag.price_cents,
    priceCents: bag.price_cents,
    choiceCharges: [],
    quantity: 1,
    selections: [],
    choiceLabels: [],
    bag: { pickup: bag.supports_pickup, delivery: bag.supports_delivery, closes: bag.pickup_window_end },
  };
}

/// The bags `delivery` (or pickup) can't have at `nowMicros`, and why.
export function bagProblems(lines: CartLine[], delivery: boolean, nowMicros: number): { line: CartLine; closed: boolean }[] {
  return lines.flatMap((line) => {
    const bag = line.bag;
    if (!bag) return [];
    const closed = bag.closes <= nowMicros;
    return closed || !(delivery ? bag.delivery : bag.pickup) ? [{ line, closed }] : [];
  });
}
