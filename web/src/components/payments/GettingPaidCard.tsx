import { CreditCard } from "lucide-react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { paymentProfileOf } from "../../holochain/zomes/payments";
import { myAgentPubKey } from "../../holochain/client";
import { bytesToHex } from "../../holochain/decode";
import { useResource } from "../../lib/hooks/useResource";
import { Card, Skeleton } from "../ui";
import { useT } from "../../i18n";

/// Where a store or driver is paid -- straight into their own processor
/// account -- and the way to set it up or change it. Until it's set up,
/// nobody can pay them by card, so it says so.
export function GettingPaidCard({ className }: { className?: string }) {
  const t = useT();
  const me = myAgentPubKey();
  const { data: profile } = useResource(`payment-profile:${bytesToHex(me)}`, () => paymentProfileOf(me));
  return (
    <Card className={clsx("flex items-center gap-3 p-5", className)}>
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-handshake-100 text-handshake-600 dark:bg-handshake-900/30">
        <CreditCard size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("payments.gettingPaid")}</p>
        {profile === undefined ? (
          <Skeleton className="mt-1 h-4 w-40" />
        ) : (
          <p className="text-xs text-ink-400">{profile ? t("payments.paidInto", { processor: profile.processor }) : t("payments.notSetUp")}</p>
        )}
      </div>
      <Link to="/payments" className="shrink-0 rounded-full bg-handshake-500 px-3.5 py-2 text-xs font-semibold text-white">
        {profile ? t("payments.manage") : t("payments.setUp")}
      </Link>
    </Card>
  );
}
