// The bar at the foot of checkout: why the order can't go yet, if it
// can't, and the button that places it -- paying by card with it. It
// floats over a phone's or tablet's screen, and sits under the order
// summary on a wide one.
import { Button } from "../../../components/ui";
import { formatCents } from "../../../lib/ui/format";
import { useT } from "../../../i18n";

interface Props {
  /// Why it can't go yet, in the order they're told.
  notes: string[];
  disabled: boolean;
  placing: boolean;
  /// What the button says it places: a pickup, a scheduled delivery, or now.
  kind: "pickup" | "scheduled" | "delivery";
  /// What it comes to: a pickup's total, a delivery's most.
  totalCents: number;
  onPlace: () => void;
}

export function CheckoutBar({ notes, disabled, placing, kind, totalCents, onPlace }: Props) {
  const t = useT();
  return (
    // Floating, it sits on a solid panel: the screen scrolls under it, and
    // neither a note nor a dimmed button may show what's behind through it.
    <div className="fixed inset-x-0 bottom-20 z-20 mx-auto max-w-md px-4 md:max-w-2xl lg:static lg:mt-4 lg:max-w-none lg:px-0">
      <div className="flex w-full flex-col gap-2 rounded-2xl bg-ink-50/95 p-2 shadow-lg backdrop-blur dark:bg-ink-950/95 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-none lg:dark:bg-transparent">
        {notes.map((note) => (
          <p key={note} className="w-full rounded-lg bg-amber-50 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            {note}
          </p>
        ))}
        <Button className="w-full" loading={placing} disabled={disabled} onClick={onPlace}>
          {kind === "pickup" ? t("cart.placePickup") : kind === "scheduled" ? t("cart.schedule") : t("cart.place")} · {kind === "pickup" ? formatCents(totalCents) : t("cart.upTo", { amount: formatCents(totalCents) })}
        </Button>
      </div>
    </div>
  );
}
