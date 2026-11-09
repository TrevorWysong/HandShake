import { create } from "zustand";
import { persist } from "zustand/middleware";
import { base64ToBytes, bytesToBase64 } from "../lib/util/base64";
import type { ActionHash, OrderItem, SelectionInput } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { selectionsKey, type GroupCharges } from "../lib/storefront/choices";
import { identityStorage, perIdentity } from "./identityScope";

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

/// One store's cart: what's in it, and the discount it's to take.
export interface StoreCart {
  catalogRef: ActionHash;
  merchant: Uint8Array;
  merchantName: string;
  lines: CartLine[];
  /// The reward redeemed into the bag, if any -- one an order. Its points
  /// are held while it's here.
  reward: CartReward | null;
  /// When it was last changed, in milliseconds -- the oldest goes first.
  touchedAt: number;
}

/// The most carts kept at once: one more drops the one left longest.
export const MAX_CARTS = 10;
/// How long a cart nobody's touched is kept, as the big apps keep one.
export const CART_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/// The store a cart is keyed by -- its catalog's original action, hex.
export const cartKey = (catalogRef: ActionHash) => bytesToHex(catalogRef);

interface CartsState {
  /// Every store's cart, by `cartKey`.
  carts: Record<string, StoreCart>;
  /// A promo code the customer chose from a store's deals (its original
  /// action, hex), by `cartKey` -- chosen before anything's in its cart, as
  /// it may be, and applied at checkout if it still applies.
  promos: Record<string, string>;
  choosePromo: (key: string, promoHex: string | null) => void;
  /// Adds `line` (its `quantity` units) to its store's cart -- to the line
  /// with the same item and choices if there is one.
  addLine: (catalogRef: ActionHash, merchant: Uint8Array, merchantName: string, line: CartLine) => void;
  /// Redeems `reward` into its store's cart: in place of any other reward,
  /// with `line` (the item it gives, if it gives one), and no promo with it.
  redeem: (catalogRef: ActionHash, merchant: Uint8Array, merchantName: string, reward: CartReward, line: CartLine | null) => void;
  /// Fills a store's cart with `lines`, in place of what was in it -- a
  /// reorder, or a recurring order brought to checkout.
  setCart: (catalogRef: ActionHash, merchant: Uint8Array, merchantName: string, lines: CartLine[]) => void;
  /// Changes the cart keyed `key`, if there is one; one left empty goes.
  change: (key: string, update: (cart: StoreCart) => Partial<StoreCart>) => void;
  /// Drops the cart keyed `key`.
  remove: (key: string) => void;
}

/// The most units of one line a cart takes -- well within what the network
/// allows of a line (`MAX_LINE_QUANTITY`).
export const MAX_UNITS = 99;

/// `lines` with `line` merged in: its units added to the line with the same
/// key, or appended, at most `MAX_UNITS`. A goodie bag is one to an order.
function merged(lines: CartLine[], line: CartLine): CartLine[] {
  const key = lineKey(line);
  if (!lines.some((l) => lineKey(l) === key)) return [...lines, { ...line, quantity: Math.min(line.quantity, MAX_UNITS) }];
  return line.bag ? lines : lines.map((l) => (lineKey(l) === key ? { ...l, quantity: Math.min(l.quantity + line.quantity, MAX_UNITS) } : l));
}

/// Hashes and keys, through JSON and back.
const BYTES = "$bytes";
const replacer = (_key: string, value: unknown) => (value instanceof Uint8Array ? { [BYTES]: bytesToBase64(value) } : value);
const reviver = (_key: string, value: unknown) =>
  value && typeof value === "object" && BYTES in value && typeof (value as Record<string, unknown>)[BYTES] === "string" ? base64ToBytes((value as Record<string, string>)[BYTES]) : value;

let lastTouch = 0;
/// Now, in milliseconds -- later than any cart touched before, so two
/// touched in the same moment still have an order.
const touch = () => (lastTouch = Math.max(Date.now(), lastTouch + 1));

/// `carts` without the ones untouched past `CART_KEPT_MS`, and the oldest
/// past `MAX_CARTS`.
function kept(carts: Record<string, StoreCart>, now: number): Record<string, StoreCart> {
  const fresh = Object.entries(carts).filter(([, cart]) => now - cart.touchedAt < CART_KEPT_MS && (cart.lines.length > 0 || cart.reward !== null));
  return Object.fromEntries(fresh.sort(([, a], [, b]) => b.touchedAt - a.touchedAt).slice(0, MAX_CARTS));
}

// Kept on this device, so a cart outlives a reload, a card payment or
// closing the tab -- as the big apps' do -- and per identity: one person's
// carts, a reward's held points included, are never another's.
export const useCarts = create<CartsState>()(
  persist(
    (set, get) => {
      /// Puts `cart` in place of its store's, newest, keeping within the limits.
      const put = (cart: StoreCart) => set({ carts: kept({ ...get().carts, [cartKey(cart.catalogRef)]: { ...cart, touchedAt: touch() } }, Date.now()) });
      const existing = (catalogRef: ActionHash, merchant: Uint8Array, merchantName: string): StoreCart =>
        get().carts[cartKey(catalogRef)] ?? { catalogRef, merchant, merchantName, lines: [], reward: null, touchedAt: Date.now() };
      /// `promos` without `key`'s.
      const promosWithout = (key: string) => Object.fromEntries(Object.entries(get().promos).filter(([store]) => store !== key));
      return {
        carts: {},
        promos: {},
        choosePromo: (key, promoHex) => set({ promos: promoHex ? { ...get().promos, [key]: promoHex } : promosWithout(key) }),
        addLine: (catalogRef, merchant, merchantName, line) => {
          const cart = existing(catalogRef, merchant, merchantName);
          put({ ...cart, merchantName, lines: merged(cart.lines, line) });
        },
        redeem: (catalogRef, merchant, merchantName, reward, line) => {
          const cart = existing(catalogRef, merchant, merchantName);
          const paid = cart.lines.filter((l) => l.rewardId == null);
          put({ ...cart, merchantName, reward, lines: line ? [...paid, { ...line, rewardId: reward.id }] : paid });
          set({ promos: promosWithout(cartKey(catalogRef)) });
        },
        setCart: (catalogRef, merchant, merchantName, lines) => put({ ...existing(catalogRef, merchant, merchantName), merchantName, reward: null, lines: lines.reduce(merged, [] as CartLine[]) }),
        change: (key, update) => {
          const cart = get().carts[key];
          if (cart) put({ ...cart, ...update(cart) });
        },
        remove: (key) => {
          const { [key]: _gone, ...rest } = get().carts;
          set({ carts: rest, promos: promosWithout(key) });
        },
      };
    },
    {
      // v3: a cart per store; v2 kept one, and carries over as its store's.
      name: "handshake.cart.v2",
      version: 3,
      storage: identityStorage({ replacer, reviver }),
      partialize: ({ carts, promos }) => ({ carts, promos }),
      migrate: (saved, version) => {
        if (version >= 3) return saved as CartsState;
        const old = saved as (Partial<Omit<StoreCart, "touchedAt">> & { promoHex?: string | null }) | null;
        if (!old?.catalogRef || !old.merchant || !old.lines?.length) return { carts: {}, promos: {} } as unknown as CartsState;
        const cart: StoreCart = { catalogRef: old.catalogRef, merchant: old.merchant, merchantName: old.merchantName ?? "", lines: old.lines, reward: old.reward ?? null, touchedAt: Date.now() };
        const key = cartKey(cart.catalogRef);
        return { carts: { [key]: cart }, promos: old.promoHex ? { [key]: old.promoHex } : {} } as unknown as CartsState;
      },
      // What's past keeping goes as it's read back.
      merge: (saved, current) => {
        const read = saved as Partial<CartsState> | undefined;
        return { ...current, carts: kept(read?.carts ?? {}, Date.now()), promos: read?.promos ?? {} };
      },
    },
  ),
);
perIdentity(useCarts);

const NO_LINES: CartLine[] = [];

/// One store's cart, as a screen reads and changes it -- empty until
/// something's added. `storeKey` is its `cartKey`.
export function useCart(storeKey: string | null) {
  const cart = useCarts((s) => (storeKey ? s.carts[storeKey] : undefined));
  const promoHex = useCarts((s) => (storeKey ? (s.promos[storeKey] ?? null) : null));
  return cartView(storeKey, cart, promoHex);
}

/// What `useCart` hands a screen, from a cart read anywhere.
export function cartView(storeKey: string | null, cart: StoreCart | undefined, promoHex: string | null) {
  const { change, remove, choosePromo } = useCarts.getState();
  const lines = cart?.lines ?? NO_LINES;
  const edit = (update: (cart: StoreCart) => Partial<StoreCart>) => storeKey && change(storeKey, update);
  const removeLine = (key: string) => edit((c) => {
    const removed = c.lines.find((l) => lineKey(l) === key);
    return { lines: c.lines.filter((l) => lineKey(l) !== key), ...(removed?.rewardId != null ? { reward: null } : {}) };
  });
  return {
    catalogRef: cart?.catalogRef ?? null,
    merchant: cart?.merchant ?? null,
    merchantName: cart?.merchantName ?? null,
    lines,
    promoHex,
    reward: cart?.reward ?? null,
    count: lines.reduce((n, l) => n + l.quantity, 0),
    total: () => lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0),
    choosePromo: (promo: string | null) => storeKey && choosePromo(storeKey, promo),
    releaseReward: () => edit((c) => ({ reward: null, lines: c.lines.filter((l) => l.rewardId == null) })),
    /// Puts `line` in place of the line keyed `key` -- editing its choices.
    replaceLine: (key: string, line: CartLine) => edit((c) => ({ lines: merged(c.lines.filter((l) => lineKey(l) !== key), line) })),
    /// Brings each line to today's price, if it's moved.
    repriceLines: (update: (line: CartLine) => CartLine) => {
      if (!cart) return;
      const repriced = cart.lines.map(update);
      if (repriced.some((line, i) => line !== cart.lines[i])) edit(() => ({ lines: repriced }));
    },
    removeLine,
    setQuantity: (key: string, quantity: number) => {
      if (quantity <= 0) return removeLine(key);
      // A reward's line holds what the reward gives, and a goodie bag's one
      // bag, no more.
      edit((c) => ({ lines: c.lines.map((l) => (lineKey(l) === key && l.rewardId == null && !l.bag ? { ...l, quantity: Math.min(quantity, MAX_UNITS) } : l)) }));
    },
    /// Empties it -- its order placed, or the customer's done with it.
    clear: () => storeKey && remove(storeKey),
  };
}

