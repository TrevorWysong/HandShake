// What an order is -- each line's quantity, item and choices ("Large, Oat
// milk, 2 x Extra shot") -- for the kitchen making it and the customer
// checking it. An order's lines never change, so they're read once.
import { ChevronDown } from "lucide-react";
import { getOrderLines } from "../../holochain/zomes/dispatch";
import { bytesToHex } from "../../holochain/decode";
import { formatCents } from "../../lib/ui/format";
import { useResource } from "../../lib/hooks/useResource";
import { Card, Skeleton } from "../ui";
import { AllergenStatement } from "../store/Allergens";
import { useT } from "../../i18n";

export function OrderLines({ orderRef, prices = false, allergens = false, className = "" }: { orderRef: Uint8Array; prices?: boolean; /** What the store said of each, when it was ordered. */ allergens?: boolean; className?: string }) {
  const t = useT();
  const { data: lines } = useResource(`order-lines:${bytesToHex(orderRef)}`, () => getOrderLines(orderRef));
  if (!lines) return <Skeleton className={`h-10 w-full ${className}`} />;
  return (
    <ul className={`flex flex-col gap-1.5 ${className}`}>
      {lines.map((line, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <span className="w-6 shrink-0 font-bold tabular-nums text-ink-900 dark:text-ink-50">{line.quantity}×</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-ink-800 dark:text-ink-100">
              {line.name}
              {line.on_sale && <span className="ml-1.5 whitespace-nowrap rounded-full bg-handshake-100 px-1.5 py-0.5 align-middle text-[10px] font-bold text-handshake-700 dark:bg-handshake-500/20 dark:text-handshake-300">{t("sale.onLine")}</span>}
              {line.goodie_bag && <span className="ml-1.5 whitespace-nowrap rounded-full bg-amber-100 px-1.5 py-0.5 align-middle text-[10px] font-bold text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">🎁 {t("lines.goodieBag")}</span>}
            </p>
            {allergens && (line.goodie_bag || line.allergens) && (
              <div className="mt-1">
                <AllergenStatement quiet facts={line.allergens} goodieBag={line.goodie_bag} added={{ contains: line.choices_contain, other: line.choices_contain_other }} />
              </div>
            )}
            {line.choices.length > 0 && (
              <ul className="mt-0.5 flex flex-col text-xs text-ink-500 dark:text-ink-400">
                {line.choices.map((choice, j) => (
                  <li key={j}>{choice}</li>
                ))}
              </ul>
            )}
          </div>
          {prices && <span className="shrink-0 tabular-nums text-ink-600 dark:text-ink-300">{formatCents(line.unit_price_cents * line.quantity)}</span>}
        </li>
      ))}
      {allergens && lines.some((line) => line.allergens) && <li className="text-[11px] leading-relaxed text-ink-400">{t("allergy.whenOrdered")}</li>}
    </ul>
  );
}

/// The order's lines in a card that opens on tap -- "Your order (3 items)",
/// and what they come to.
export function OrderSummary({ orderRef, count, total }: { orderRef: Uint8Array; count: number; total: number }) {
  const t = useT();
  return (
    <Card className="p-4">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-ink-900 dark:text-ink-50">
          {t("lines.summary", { count })}
          <span className="flex items-center gap-1.5">
            <span className="tabular-nums">{formatCents(total)}</span>
            <ChevronDown size={16} aria-hidden className="text-ink-400 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <OrderLines orderRef={orderRef} prices allergens className="mt-3" />
      </details>
    </Card>
  );
}
