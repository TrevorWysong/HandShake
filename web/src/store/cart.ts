import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { base64ToBytes, bytesToBase64 } from "../lib/util/base64";
import type { ActionHash, OrderItem, SelectionInput } from "../holochain/types";
import { bytesEqual, bytesToHex } from "../holochain/decode";
import { selectionsKey, type GroupCharges } from "../lib/storefront/choices";

export interface CartLine {
  itemRef: ActionHash;
  name: string;
  /// The item's own price -- what an item promo takes off.
  basePriceCents: number;
  /// One unit with its choices.
  priceCents: number;
  /// What its choices add, by group -- what an item reward can cover.
  choiceCharges: GroupCharges[];
  quantity: number;
  /// What was chosen, as the order sends it -- empty for an item without
  /// choices.
  selections: SelectionInput[];
  /// The choices as the customer reads them: "Large", "Oat milk".
  choiceLabels: string[];
  /// Set on the line a reward put in the bag (`CartReward`): free, and kept
  /// apart from any units of the same item the customer pays for.
  rewardId?: number;
  /// Set on a goodie bag's line: one of it, had the ways it allows, while
  /// its window's open.
  bag?: BagTerms;
}

/// A goodie bag's terms, as checkout needs them.
export interface BagTerms {
  pickup: boolean;
  delivery: boolean;
  /// When its window closes, in microseconds.
  closes: number;
}

/// The cart's menu lines -- its goodie bags aside, which promos, rewards
/// and a store's minimum don't count (the network's rule).
export const menuLines = (lines: CartLine[]) => lines.filter((line) => !line.bag);

/// A reward the customer redeemed into their bag: its points are held for
/// it -- shown as spent -- until the order goes in, and come back if they
/// take it out. The store checks the points again as it accepts the order.
export interface CartReward {
  id: number;
  name: string;
  cost: number;
}

/// A line's identity: its item and its choices. The same item with other
/// choices is another line.
export function lineKey(line: Pick<CartLine, "itemRef" | "selections" | "rewardId">): string {
  return `${bytesToHex(line.itemRef)}|${selectionsKey(line.selections)}${line.rewardId == null ? "" : `|reward:${line.rewardId}`}`;
}

/// The cart as an order's items -- one per item and choices, its quantity
/// the paid units and a reward's together: the order prices the reward off
/// them, as validation does.
export function cartItems(lines: CartLine[]): OrderItem[] {
  const items: (OrderItem & { key: string })[] = [];
  for (const line of lines) {
    const key = lineKey({ ...line, rewardId: undefined });
    const same = items.find((i) => i.key === key);
    if (same) same.quantity += line.quantity;
    else items.push({ key, item_ref: line.itemRef, quantity: line.quantity, selections: line.selections });
  }
  return items.map(({ key: _key, ...item }) => item);
}

interface CartState {
  catalogRef: ActionHash | null;
  merchant: Uint8Array | null;
  merchantName: string | null;
  lines: CartLine[];
  /// A promo code the customer chose from the store's deals (its original
  /// action, hex) -- applied at checkout if it's this cart's store's.
  promoHex: string | null;
  choosePromo: (hex: string | null) => void;
  /// The reward redeemed into the bag, if any -- one an order.
  reward: CartReward | null;
  /// Redeems `reward` into the bag at the store: in place of any other
  /// reward, with `line` (the item it gives, if it gives one). A bag from
  /// another store is emptied first, as adding an item does.
  redeem: (catalogRef: ActionHash, merchant: Uint8Array, merchantName: string, reward: CartReward, line: CartLine | null) => void;
  /// Takes the reward back out of the bag, and its line: the points are free again.
  releaseReward: () => void;

  /// Adds `line` (its `quantity` units) -- to the line with the same item
  /// and choices if there is one.
  addLine: (catalogRef: ActionHash, merchant: Uint8Array, merchantName: string, line: CartLine) => void;
  /// Puts `line` in place of the line keyed `key` -- editing its choices.
  replaceLine: (key: string, line: CartLine) => void;
  removeLine: (key: string) => void;
  setQuantity: (key: string, quantity: number) => void;
  /// Replaces the cart wholesale -- used by "reorder" to repopulate from a
  /// past order in one shot.
  setCart: (catalogRef: ActionHash, merchant: Uint8Array, merchantName: string, lines: CartLine[]) => void;
  clear: () => void;
  total: () => number;
}

/// `lines` with `line` merged in: its units added to the line with the same
/// key, or appended. A goodie bag is one to an order.
function merged(lines: CartLine[], line: CartLine): CartLine[] {
  const key = lineKey(line);
  if (!lines.some((l) => lineKey(l) === key)) return [...lines, line];
  return line.bag ? lines : lines.map((l) => (lineKey(l) === key ? { ...l, quantity: l.quantity + line.quantity } : l));
}

/// Hashes and keys, through JSON and back.
const BYTES = "$bytes";
const replacer = (_key: string, value: unknown) => (value instanceof Uint8Array ? { [BYTES]: bytesToBase64(value) } : value);
const reviver = (_key: string, value: unknown) =>
  value && typeof value === "object" && BYTES in value && typeof (value as Record<string, unknown>)[BYTES] === "string" ? base64ToBytes((value as Record<string, string>)[BYTES]) : value;

// Kept on this device, so a cart outlives a reload, a card payment or
// closing the tab -- as the big apps' do.
export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      catalogRef: null,
      merchant: null,
      merchantName: null,
      lines: [],
      promoHex: null,
      reward: null,

      choosePromo: (promoHex) => set({ promoHex }),

      redeem: (catalogRef, merchant, merchantName, reward, line) => {
        const state = get();
        const sameCatalog = state.catalogRef && bytesEqual(state.catalogRef, catalogRef);
        const kept = (sameCatalog ? state.lines : []).filter((l) => l.rewardId == null);
        set({ catalogRef, merchant, merchantName, reward, promoHex: null, lines: line ? [...kept, { ...line, rewardId: reward.id }] : kept });
      },

      releaseReward: () => set({ reward: null, lines: get().lines.filter((l) => l.rewardId == null) }),

      addLine: (catalogRef, merchant, merchantName, line) => {
        const state = get();
        // Switching restaurants clears the cart -- same rule every real
        // delivery app enforces, since one order can only reference one
        // catalog_ref/merchant on the backend.
        const sameCatalog = state.catalogRef && bytesEqual(state.catalogRef, catalogRef);
        set({ catalogRef, merchant, merchantName, lines: merged(sameCatalog ? state.lines : [], line), ...(sameCatalog ? {} : { reward: null }) });
      },

      replaceLine: (key, line) => set({ lines: merged(get().lines.filter((l) => lineKey(l) !== key), line) }),

      removeLine: (key) => {
        const removed = get().lines.find((l) => lineKey(l) === key);
        set({ lines: get().lines.filter((l) => lineKey(l) !== key), ...(removed?.rewardId != null ? { reward: null } : {}) });
      },

      setQuantity: (key, quantity) => {
        if (quantity <= 0) {
          get().removeLine(key);
          return;
        }
        // A reward's line holds what the reward gives, and a goodie bag's
        // one bag, no more.
        set({ lines: get().lines.map((l) => (lineKey(l) === key && l.rewardId == null && !l.bag ? { ...l, quantity } : l)) });
      },

      setCart: (catalogRef, merchant, merchantName, lines) => set({ catalogRef, merchant, merchantName, reward: null, lines: lines.reduce(merged, [] as CartLine[]) }),

      clear: () => set({ catalogRef: null, merchant: null, merchantName: null, lines: [], promoHex: null, reward: null }),

      total: () => get().lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0),
    }),
    {
      // v2: lines carry their choices' charges.
      name: "handshake.cart.v2",
      storage: createJSONStorage(() => localStorage, { replacer, reviver }),
      partialize: ({ catalogRef, merchant, merchantName, lines, promoHex, reward }) => ({ catalogRef, merchant, merchantName, lines, promoHex, reward }),
    },
  ),
);
