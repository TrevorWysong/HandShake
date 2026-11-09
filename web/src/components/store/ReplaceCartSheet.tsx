// "Replace your cart?" -- before a store's cart is filled again with an
// order's items (`useCartReplace`).
import { Sheet } from "../Sheet";
import { Button } from "../ui";
import { useT } from "../../i18n";
import type { CartReplace } from "../../lib/hooks/useCartReplace";

export function ReplaceCartSheet({ pending, onConfirm, onCancel }: { pending: CartReplace | null; onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  return (
    <Sheet
      open={!!pending}
      onClose={onCancel}
      title={t("cart.replace.title")}
      footer={
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onCancel}>
            {t("cart.replace.keep")}
          </Button>
          <Button className="flex-1" onClick={onConfirm}>
            {t("cart.replace.confirm")}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-ink-600 dark:text-ink-300">{t("cart.replace.detail", { store: pending?.store ?? "" })}</p>
    </Sheet>
  );
}
