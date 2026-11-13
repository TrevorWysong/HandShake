// A driver's customers of the last few days, not yet rated: how each was,
// for the stores and drivers who serve them next (docs/REPUTATION.md,
// phase 4). Gone once there are none.
import { ThumbsUp } from "lucide-react";
import { myRecentDeliveries } from "../../holochain/zomes/dispatch";
import { myCustomerRating } from "../../holochain/zomes/reputation";
import { bytesToHex } from "../../holochain/decode";
import { storeName } from "../../lib/reputation/blockTargets";
import { useResource } from "../../lib/hooks/useResource";
import { Card, SectionLabel } from "../../components/ui";
import { TimeAgo } from "../../components/TimeAgo";
import { RateCustomer } from "../../components/reputation/RateCustomer";
import { useT } from "../../i18n";

/// How many recent deliveries are offered for rating at once.
const OFFERED = 5;

export function RecentCustomers({ driverHex }: { driverHex: string }) {
  const t = useT();
  const { data: unrated } = useResource(`recent-customers:${driverHex}`, async () => {
    const recent = await myRecentDeliveries(OFFERED * 2);
    const rated = await Promise.all(recent.map((delivery) => myCustomerRating(delivery.order).catch(() => null)));
    const open = recent.filter((_, i) => rated[i] === null).slice(0, OFFERED);
    return Promise.all(open.map(async (delivery) => ({ ...delivery, store: await storeName(delivery.catalog_ref).catch(() => "") })));
  });
  if (!unrated || unrated.length === 0) return null;
  return (
    <Card className="mb-5 p-4">
      <SectionLabel as="h2" icon={<ThumbsUp size={13} aria-hidden />} className="mb-1">{t("rateCustomer.recentTitle")}</SectionLabel>
      <p className="mb-3 text-xs leading-relaxed text-ink-500 dark:text-ink-400">{t("rateCustomer.recentDetail")}</p>
      <ul className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800">
        {unrated.map((delivery) => (
          <li key={bytesToHex(delivery.order)} className="py-3 first:pt-0 last:pb-0">
            <p className="mb-2 text-xs text-ink-500 dark:text-ink-400">
              <span className="font-semibold text-ink-800 dark:text-ink-100">{delivery.store}</span> · <TimeAgo at={delivery.delivered_at} />
            </p>
            <RateCustomer order={delivery.order} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
