import { useNavigate } from "react-router-dom";
import { Store } from "lucide-react";
import { Button, EmptyState } from "../ui";
import { useT } from "../../i18n";

/// A seller's tab before they've a store for it to be about: what it's for
/// (`detail`), and the way to set one up.
export function NoStoreYet({ detail }: { detail: string }) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center px-4">
      <EmptyState icon={<Store size={32} />} title={t("merchantOrders.noStore")} subtitle={detail} />
      <Button onClick={() => navigate("/merchant/store")}>{t("merchantOrders.setUp")}</Button>
    </div>
  );
}
