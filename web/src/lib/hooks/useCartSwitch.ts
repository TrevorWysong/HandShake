// Asking before a cart from one store gives way to another: a cart holds
// one store's order, so adding from another store starts it over.
import { useState } from "react";
import { useCart } from "../../store/cart";
import { bytesEqual } from "../../holochain/decode";
import type { ActionHash } from "../../holochain/types";

export interface CartSwitch {
  /// The store whose cart would be cleared.
  from: string;
  proceed: () => void;
}

export function useCartSwitch() {
  const [pending, setPending] = useState<CartSwitch | null>(null);
  return {
    pending,
    /// Runs `proceed` now if it keeps what's in the cart, else once asked.
    /// `replacing` asks of any cart, the same store's too: it's replaced.
    ask: (catalogRef: ActionHash, proceed: () => void, replacing = false) => {
      const { catalogRef: current, lines, merchantName } = useCart.getState();
      if (lines.length === 0 || !current || (!replacing && bytesEqual(current, catalogRef))) return proceed();
      setPending({ from: merchantName ?? "", proceed });
    },
    confirm: () => {
      pending?.proceed();
      setPending(null);
    },
    cancel: () => setPending(null),
  };
}
