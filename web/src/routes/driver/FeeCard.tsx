// What a driver charges (`FeeScheduleEditor`) and whether their app bids it
// for them on every order they're offered. Kept on this device
// (`roleSettings`): customers and stores see only the fee in a bid.
import { CircleDollarSign } from "lucide-react";
import { Input, Switch } from "../../components/ui";
import { formatCents } from "../../lib/ui/format";
import { orderedBands } from "../../lib/driving/feeSchedule";
import { useDriverSettings } from "../../store/roleSettings";
import { useT } from "../../i18n";
import { FeeScheduleEditor } from "./FeeScheduleEditor";
import { SettingsCard } from "./SettingsCard";
import { ScoreThreshold } from "../../components/reputation/ScoreThreshold";

export function FeeCard() {
  const t = useT();
  const { fees, autoBid, setAutoBid } = useDriverSettings();
  const bands = orderedBands(fees.bands);
  const summary = [
    fees.kind === "rate"
      ? t("driverSettings.ratePer", { amount: formatCents(fees.perUnitCents), unit: t(fees.unit === "mi" ? "fees.mi" : "fees.km") })
      : bands.length > 0
        ? t("fees.summaryBands", { amount: formatCents(bands[0].feeCents), count: bands.length })
        : t("fees.summaryNone"),
    autoBid.on ? t("driverSettings.bidding") : t("fees.summaryByHand"),
  ].join(" · ");
  return (
    <SettingsCard icon={CircleDollarSign} title={t("fees.cardTitle")} summary={summary}>
      <FeeScheduleEditor />
      <div className="flex items-center justify-between gap-3 border-t border-ink-100 pt-4 dark:border-ink-800">
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-ink-500">{t("driverSettings.autoBid")}</span>
          <span className="block text-[0.6875rem] text-ink-400">{t("driverSettings.autoBidDetail")}</span>
        </span>
        <Switch checked={autoBid.on} onChange={(on) => setAutoBid({ on })} label={t("driverSettings.autoBidLabel")} />
      </div>
      {autoBid.on && (
        <>
          <label className="block text-xs font-semibold text-ink-500">
            {t("driverSettings.skip")}
            <Input type="number" min={1} step={1} value={autoBid.skipRefusals} onChange={(e) => setAutoBid({ skipRefusals: Math.max(1, Math.round(Number(e.target.value)) || 1) })} suffix={t("driverSettings.times")} className="mt-1 py-1.5 text-sm" />
          </label>
          <ScoreThreshold
            label={t("driverSettings.skipCustomers")}
            detail={t("driverSettings.skipCustomersDetail")}
            value={autoBid.skipBelowCustomerScore}
            onChange={(skipBelowCustomerScore) => setAutoBid({ skipBelowCustomerScore })}
          />
          <p className="text-[0.6875rem] text-ink-400">{t("driverSettings.autoBidNote")}</p>
        </>
      )}
    </SettingsCard>
  );
}
