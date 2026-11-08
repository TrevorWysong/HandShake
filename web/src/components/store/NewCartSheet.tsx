// "Start a new cart?" -- before a cart from one store is cleared for
// another's (`useCartSwitch`).
import { Sheet } from "../Sheet";
import { Button } from "../ui";
import { useT } from "../../i18n";
import type { CartSwitch } from "../../lib/hooks/useCartSwitch";

export function NewCartSheet({ pending, onConfirm, onCancel }: { pending: CartSwitch | null; onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  return (
    <Sheet
      open={!!pending}
      onClose={onCancel}
      title={t("cart.switch.title")}
      footer={
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onCancel}>
            {t("cart.switch.keep")}
          </Button>
          <Button className="flex-1" onClick={onConfirm}>
            {t("cart.switch.start")}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-ink-600 dark:text-ink-300">{t("cart.switch.detail", { store: pending?.from ?? "" })}</p>
    </Sheet>
  );
}
