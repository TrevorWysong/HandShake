// The store or the driver rating an order's customer, once (docs/
// REPUTATION.md, phase 4): a thumbs-up, or a thumbs-down with a reason from
// a fixed list -- never about tipping. The customer sees how many of each,
// never who gave them. A store never rates a customer who reported the
// order -- it answers the report instead -- so it isn't asked to.
import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { myCustomerRating, rateCustomer } from "../../holochain/zomes/reputation";
import { getIssuesForOrder } from "../../holochain/zomes/dispatch";
import { bytesToHex } from "../../holochain/decode";
import type { CustomerReason } from "../../holochain/types";
import { CUSTOMER_REASONS, CUSTOMER_REASON_LABEL } from "../../lib/reputation/customers";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";
import { Button, Chip, Notice } from "../ui";
import { useT } from "../../i18n";

export function RateCustomer({ order, asStore = false, className }: { order: Uint8Array; asStore?: boolean; className?: string }) {
  const t = useT();
  const hex = bytesToHex(order);
  const { data: mine, reload } = useResource(`my-customer-rating:${hex}`, () => myCustomerRating(order));
  // Only read while there's still a rating to give.
  const { data: reports } = useResource(asStore && mine === null ? `issues:${hex}` : null, () => getIssuesForOrder(order));
  const [down, setDown] = useState(false);
  const [reason, setReason] = useState<CustomerReason | null>(null);
  const rating = useAction();
  const send = (up: boolean) => rating.run(async () => {
    await rateCustomer({ order, up, reason: up ? null : reason });
    await reload();
  });

  if (mine === undefined) return null;
  if (asStore && !mine && (reports === undefined || reports.length > 0)) return null;
  if (mine) {
    return (
      <p className={`flex items-center gap-1.5 text-xs text-ink-500 dark:text-ink-400 ${className ?? ""}`} role="status">
        {mine.up ? <ThumbsUp size={14} aria-hidden /> : <ThumbsDown size={14} aria-hidden />}
        {mine.up ? t("rateCustomer.ratedUp") : t("rateCustomer.ratedDown", { reason: t(CUSTOMER_REASON_LABEL[mine.reason ?? "Other"]) })}
      </p>
    );
  }
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink-600 dark:text-ink-300">{t("rateCustomer.ask")}</span>
        <span className="flex gap-2">
          <button type="button" onClick={() => send(true)} disabled={rating.busy} aria-label={t("rateCustomer.up")} className="grid h-10 w-10 place-items-center rounded-full bg-ink-100 text-ink-700 transition hover:bg-green-100 hover:text-green-700 disabled:opacity-40 dark:bg-ink-800 dark:text-ink-200 forced-colors:border">
            <ThumbsUp size={18} aria-hidden />
          </button>
          <button type="button" onClick={() => setDown(!down)} aria-pressed={down} disabled={rating.busy} aria-label={t("rateCustomer.down")} className={`grid h-10 w-10 place-items-center rounded-full transition disabled:opacity-40 forced-colors:border ${down ? "bg-ink-900 text-white dark:bg-white dark:text-ink-900" : "bg-ink-100 text-ink-700 hover:bg-amber-100 hover:text-amber-700 dark:bg-ink-800 dark:text-ink-200"}`}>
            <ThumbsDown size={18} aria-hidden />
          </button>
        </span>
      </div>
      {down && (
        <div className="mt-2">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("rateCustomer.why")}>
            {CUSTOMER_REASONS.map((r) => (
              <Chip key={r} active={reason === r} onClick={() => setReason(r)}>{t(CUSTOMER_REASON_LABEL[r])}</Chip>
            ))}
          </div>
          <p className="mt-2 text-[0.6875rem] leading-relaxed text-ink-400">{t("rateCustomer.private")}</p>
          <Button variant="secondary" className="mt-2 w-full py-2 text-xs" disabled={reason === null} loading={rating.busy} onClick={() => send(false)}>
            {t("rateCustomer.send")}
          </Button>
        </div>
      )}
      {rating.error && <Notice className="mt-2">{rating.error}</Notice>}
    </div>
  );
}
