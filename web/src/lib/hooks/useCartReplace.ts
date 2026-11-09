// Asking before a store's cart is filled again -- a reorder puts its items in
// place of what's there. Each store has its own cart, so nothing else is
// touched, and a cart that's empty is filled without asking.
import { useState } from "react";
import { cartKey, useCarts } from "../../store/cart";
import type { ActionHash } from "../../holochain/types";

export interface CartReplace {
  /// The store whose cart would be replaced.
  store: string;
  proceed: () => void;
}

export function useCartReplace() {
  const [pending, setPending] = useState<CartReplace | null>(null);
  return {
    pending,
    /// Runs `proceed` now if the store's cart is empty, else once asked.
    ask: (catalogRef: ActionHash, proceed: () => void) => {
      const cart = useCarts.getState().carts[cartKey(catalogRef)];
      if (!cart?.lines.length) return proceed();
      setPending({ store: cart.merchantName, proceed });
    },
    confirm: () => {
      pending?.proceed();
      setPending(null);
    },
    cancel: () => setPending(null),
  };
}
