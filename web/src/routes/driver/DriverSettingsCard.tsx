// A driver's own limits on what they're offered -- each within the
// network's, which it enforces regardless -- and the speed their bid ETAs
// are estimated from. Kept on this device (`roleSettings`). What they
// charge is its own card (`FeeCard`).
import { SlidersHorizontal } from "lucide-react";
import { Chip, Input, Switch } from "../../components/ui";
import { centsTyped, currencySymbol, formatCents, fromMinorUnits } from "../../lib/ui/format";
import { useTerms } from "../../store/network";
import { DETOUR_CHOICES_KM, useDriverSettings } from "../../store/roleSettings";
import { useT } from "../../i18n";
import { TRAVEL_MODES } from "../../lib/driving/routing";
import { SettingsCard } from "./SettingsCard";

export function DriverSettingsCard() {
  const t = useT();
  const terms = useTerms();
  const networkMax = terms.max_concurrent_deliveries;
  const { limits, travelMode, setLimits, setTravelMode } = useDriverSettings();
  const atOnce = Math.min(limits.maxAtOnce ?? networkMax, networkMax);
  const summary = [
    t("driverSettings.upTo", { count: atOnce }),
    limits.takePriority ? t("driverSettings.priorityOn") : t("driverSettings.priorityOff"),
    limits.minFeeCents > 0 ? t("driverSettings.minFee", { amount: formatCents(limits.minFeeCents) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SettingsCard icon={SlidersHorizontal} title={t("driverSettings.title")} summary={summary}>
              <div>
                <p className="mb-2 text-xs font-semibold text-ink-500">{t("driverSettings.most")}</p>
                <div className="flex gap-2">
                  {Array.from({ length: networkMax }, (_, i) => i + 1).map((count) => (
                    <button
                      key={count}
                      onClick={() => setLimits({ maxAtOnce: count === networkMax ? null : count })}
                      className={`h-9 w-9 rounded-full text-sm font-semibold transition ${count === atOnce ? "bg-handshake-500 text-white" : "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"}`}
                    >
                      {count}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[0.6875rem] text-ink-400">{t("driverSettings.networkAllows", { count: networkMax })}</p>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>
                  <span className="block text-xs font-semibold text-ink-500">{t("driverSettings.priority")}</span>
                  <span className="block text-[0.6875rem] text-ink-400">{t("driverSettings.priorityDetail")}</span>
                </span>
                <Switch checked={limits.takePriority} onChange={(takePriority) => setLimits({ takePriority })} label={t("driverSettings.takePriority")} />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold text-ink-500">{t("driverSettings.detour")}</p>
                <div className="flex flex-wrap gap-2">
                  {DETOUR_CHOICES_KM.map((km) => (
                    <Chip key={km} active={(limits.detourKm ?? terms.add_on_detour_km) === km} onClick={() => setLimits({ detourKm: km === terms.add_on_detour_km ? null : km })}>
                      {t("driverSettings.km", { km })}
                    </Chip>
                  ))}
                </div>
                <p className="mt-1.5 text-[0.6875rem] text-ink-400">{t("driverSettings.detourDetail", { km: terms.add_on_detour_km })}</p>
              </div>
              <label className="block text-xs font-semibold text-ink-500">
                {t("driverSettings.lowestFee")}
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  value={fromMinorUnits(limits.minFeeCents)}
                  onChange={(e) => setLimits({ minFeeCents: centsTyped(e.target.value) })}
                  prefix={currencySymbol()}
                  className="mt-1 py-1.5 text-sm"
                />
              </label>
              <div>
                <span className="block text-xs font-semibold text-ink-500">{t("driverSettings.travel")}</span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {TRAVEL_MODES.map(({ mode, label }) => (
                    <Chip key={mode} active={travelMode === mode} onClick={() => setTravelMode(mode)}>
                      {t(label)}
                    </Chip>
                  ))}
                </div>
                <p className="mt-2 text-[0.6875rem] text-ink-400">{t("driverSettings.travelNote")}</p>
              </div>
    </SettingsCard>
  );
}
