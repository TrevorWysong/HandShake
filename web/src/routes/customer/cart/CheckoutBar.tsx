// The bar at the foot of checkout: why the order can't go yet, if it
// can't, and the button that places it -- or first pays the shortfall by
// card, when the balance won't cover it.
import { Button } from "../../../components/ui";
import { formatCents } from "../../../lib/ui/format";
import { useT } from "../../../i18n";

interface Props {
  /// Why it can't go yet, in the order they're told.
  notes: string[];
  disabled: boolean;
  placing: boolean;
  /// The card payment first, if that's what the button does.
  cardCents: number | null;
  /// What the button says it places: a pickup, a scheduled delivery, or now.
  kind: "pickup" | "scheduled" | "delivery";
  /// What it comes to: a pickup's total, a delivery's most.
  totalCents: number;
  onPlace: () => void;
  onPay: () => void;
}

export function CheckoutBar({ notes, disabled, placing, cardCents, kind, totalCents, onPlace, onPay }: Props) {
  const t = useT();
  return (
    <div className="fixed inset-x-0 bottom-20 z-20 mx-auto flex max-w-md flex-col items-center gap-2 px-4 lg:bottom-6 lg:left-64">
      {notes.map((note) => (
        <p key={note} className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
          {note}
        </p>
      ))}
      <Button className="w-full" loading={placing} disabled={disabled} onClick={cardCents !== null ? onPay : onPlace}>
        {cardCents !== null ? (
          t(kind === "scheduled" ? "cart.payAndSchedule" : "cart.payAndPlace", { amount: formatCents(cardCents) })
        ) : (
          <>
            {kind === "pickup" ? t("cart.placePickup") : kind === "scheduled" ? t("cart.schedule") : t("cart.place")} · {kind === "pickup" ? formatCents(totalCents) : t("cart.upTo", { amount: formatCents(totalCents) })}
          </>
        )}
      </Button>
    </div>
  );
}
