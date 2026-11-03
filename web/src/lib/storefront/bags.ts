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

/// Why an order can't have a bag: it's the customer's own store's, its
/// window has closed, or it isn't offered the way the order is had.
export type BagProblem = { line: CartLine; reason: "own" | "closed" | "way" };

/// The bags `delivery` (or pickup) can't have at `nowMicros` -- all of
/// them, if the customer is the store's owner (`own`) -- and why.
export function bagProblems(lines: CartLine[], delivery: boolean, nowMicros: number, own: boolean): BagProblem[] {
  return lines.flatMap((line): BagProblem[] => {
    const bag = line.bag;
    if (!bag) return [];
    if (own) return [{ line, reason: "own" }];
    if (bag.closes <= nowMicros) return [{ line, reason: "closed" }];
    return delivery ? (bag.delivery ? [] : [{ line, reason: "way" }]) : bag.pickup ? [] : [{ line, reason: "way" }];
  });
}
