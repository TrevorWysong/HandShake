// What a store is shown when a customer says they were there and their
// driver says nobody came: the driver's photo of the door, and how far from
// the customer's address the driver recorded arriving -- each labelled with
// whose it is, since the store can't check either for itself.
import { Camera, MapPin } from "lucide-react";
import clsx from "clsx";
import { getArrivalEvidence } from "../../holochain/zomes/dispatch";
import { useResource } from "../../lib/hooks/useResource";
import { ARRIVAL_NEAR_KM } from "../../lib/orders/arrival";
import { formatDistance } from "../../lib/ui/format";
import { useT } from "../../i18n";
import { InfoSheet } from "../InfoSheet";

export function NoShowEvidence({ orderHex, orderRef }: { orderHex: string; orderRef: Uint8Array }) {
  const t = useT();
  const { data } = useResource(`arrival-evidence:${orderHex}`, () => getArrivalEvidence(orderRef));
  if (!data || (data.door_photo === null && data.arrived_metres === null)) return null;
  const km = data.arrived_metres === null ? null : data.arrived_metres / 1000;
  const far = km !== null && km > ARRIVAL_NEAR_KM;
  const sections = (["photo", "distance", "private"] as const).map((part) => ({ title: t(`noShowEvidence.why.${part}`), body: t(`noShowEvidence.why.${part}Detail`) }));
  return (
    <div className="mt-3 space-y-2 rounded-xl bg-white/70 p-3 dark:bg-ink-900/40">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("noShowEvidence.title")}</p>
        <InfoSheet title={t("noShowEvidence.how")} sections={sections} />
      </div>
      {km !== null && (
        <p className={clsx("flex items-start gap-2 text-xs", far ? "font-semibold text-red-700 dark:text-red-300" : "text-ink-600 dark:text-ink-300")}>
          <MapPin size={14} className="mt-0.5 shrink-0" />
          {t(far ? "noShowEvidence.far" : "noShowEvidence.near", { distance: formatDistance(km) })}
        </p>
      )}
      {data.door_photo ? (
        <figure>
          <img src={data.door_photo} alt={t("noShowEvidence.photo")} className="max-h-56 w-full rounded-lg object-cover" />
          <figcaption className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-400">
            <Camera size={12} />
            {t("noShowEvidence.photo")}
          </figcaption>
        </figure>
      ) : (
        <p className="flex items-center gap-2 text-xs text-ink-400">
          <Camera size={14} />
          {t("noShowEvidence.noPhoto")}
        </p>
      )}
    </div>
  );
}
