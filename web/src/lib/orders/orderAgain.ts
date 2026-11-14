// The stores a customer has ordered from, for "Order again": newest first,
// each once.

/// How many the row shows: enough to scroll, few enough to read quickly.
export const ORDER_AGAIN_MAX = 8;

/// The distinct stores among `orders` (newest first), in that order, up to
/// `max`.
export function storesOrderedFrom<O extends { order: { catalog_ref: Uint8Array } }>(orders: readonly O[], max = ORDER_AGAIN_MAX): Uint8Array[] {
  const seen = new Set<string>();
  const out: Uint8Array[] = [];
  for (const { order } of orders) {
    const key = Array.from(order.catalog_ref).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(order.catalog_ref);
    if (out.length === max) break;
  }
  return out;
}
