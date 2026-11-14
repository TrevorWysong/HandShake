// The delivery half of checkout -- where it's going and how it's handed
// over, how it's driven, who picks the driver, when, and repeating it. A
// pickup shows none of it: it has no driver (`PickupOrder` in
// dispatch_integrity is its own entry type for that reason).
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AddressSwitcher } from "../../../components/places/AddressSwitcher";
import { AddressLine2Field } from "../../../components/places/SplitAddressFields";
import { InfoTip } from "../../../components/InfoTip";
import { Button, Checkbox, Input, SectionLabel, SegmentedTabs, Select } from "../../../components/ui";
import type { DropoffPreference, GeoPoint, RecurrenceRule } from "../../../holochain/types";
import { appLocale, useT } from "../../../i18n";
import { Section } from "./CartPieces";
import { DELIVERY_SPEEDS, DROPOFF_PREFERENCE_OPTIONS, MATCHING } from "./options";
import { validateDropoffRadius } from "./checkout";
import type { DeliveryOptions } from "./useDeliveryOptions";

/// Where it's going, and how it's handed over there. `preference` is what
/// applies -- the door only where the store allows it for this order.
export function DeliverToSection({ options, preference, doorAllowed, store }: { options: DeliveryOptions; preference: DropoffPreference; doorAllowed: boolean; store: { location: GeoPoint | null; radiusKm: number | null } }) {
  const t = useT();
  return (
    <Section title={t("cart.deliverTo")}>
      <AddressSwitcher value={options.dropoff} onChange={options.setDropoff} onLine2={options.setDropoffLine2} onValidate={(point) => validateDropoffRadius(point, store.location, store.radiusKm)} label={t("cart.deliverTo")} />
      <div className="mt-3">
        <AddressLine2Field value={options.dropoffLine2} onChange={options.setDropoffLine2} />
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-ink-400">
        <Checkbox checked={options.saveAsDefault} onChange={(e) => options.setSaveAsDefault(e.target.checked)} />
        {t("cart.saveDefault")}
      </label>
      <SectionLabel className="mb-2 mt-3">{t("cart.dropoff")}</SectionLabel>
      <SegmentedTabs label={t("cart.dropoff")} tabs={DROPOFF_PREFERENCE_OPTIONS.filter(({ value }) => value !== "LeaveAtDoor" || doorAllowed).map(({ value, label }) => ({ value, label: t(label) }))} value={preference} onChange={options.choosePreference} />
      {preference === "LeaveAtDoor" ? (
        <label className="mt-3 flex items-start gap-2.5 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">
          <Checkbox checked={options.doorRiskAccepted} onChange={(e) => options.setDoorRiskAccepted(e.target.checked)} className="mt-0.5" />
          <span>
            <span className="font-semibold">{t("cart.door.risk")}</span> {t("cart.door.riskDetail")}
          </span>
        </label>
      ) : (
        <p className="mt-2 text-xs text-ink-400">{t("cart.door.code")}</p>
      )}
      {!doorAllowed && <p className="mt-1 text-xs text-ink-400">{t("cart.door.tooLarge")}</p>}
    </Section>
  );
}

/// Standard or priority -- and, behind the "i", what happens if the store
/// or the driver runs late.
export function SpeedSection({ priority, onChange, storeWaitMinutes }: { priority: boolean; onChange: (priority: boolean) => void; storeWaitMinutes: number }) {
  const t = useT();
  return (
    <Section
      title={t("cart.delivery")}
      right={
        <InfoTip label={t("cart.late.label")}>
          <p className="font-semibold text-ink-900 dark:text-ink-50">{t("cart.late.title")}</p>
          <p className="mt-1">{t("cart.late.storeWait", { minutes: storeWaitMinutes })}</p>
          <p className="mt-1">{t("cart.late.noDriver")}</p>
        </InfoTip>
      }
    >
      <SegmentedTabs label={t("cart.delivery")} tabs={DELIVERY_SPEEDS.map(({ priority: value, label }) => ({ value: String(value), label: t(label) }))} value={String(priority)} onChange={(value) => onChange(value === "true")} />
      <p className="mt-2 text-xs text-ink-400">{t(DELIVERY_SPEEDS.find((speed) => speed.priority === priority)!.detail)}</p>
    </Section>
  );
}

/// The app picks the driver by the network's rule, or the customer does.
export function MatchingSection({ autoMatch, onChange }: { autoMatch: boolean; onChange: (autoMatch: boolean) => void }) {
  const t = useT();
  return (
    <Section title={t("cart.driver")}>
      <SegmentedTabs label={t("cart.driver")} tabs={MATCHING.map(({ autoMatch: value, label }) => ({ value: String(value), label: t(label) }))} value={String(autoMatch)} onChange={(value) => onChange(value === "true")} />
      <p className="mt-2 text-xs text-ink-400">{t(MATCHING.find((m) => m.autoMatch === autoMatch)!.detail)}</p>
    </Section>
  );
}

/// Now, or at a time picked.
export function WhenSection({ options }: { options: DeliveryOptions }) {
  const t = useT();
  return (
    <Section title={t("cart.when")}>
      <div className="mb-2">
        <SegmentedTabs label={t("cart.when")} tabs={[{ value: "now", label: t("cart.now") }, { value: "later", label: t("cart.later") }]} value={options.scheduled ? "later" : "now"} onChange={(value) => options.setScheduled(value === "later")} />
      </div>
      <AnimatePresence initial={false}>
        {options.scheduled && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <Input type="datetime-local" value={options.scheduledFor} onChange={(e) => options.setScheduledFor(e.target.value)} />
            <p className="mt-1 text-xs text-ink-400">{t("cart.laterDetail")}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}

/// Saving this order to repeat daily or weekly at a time. Saving is the
/// checkout's own step (`onSave`), so it can't run alongside placing it.
export function RepeatSection({ saving, busy, onSave }: { saving: boolean; busy: boolean; onSave: (rule: RecurrenceRule) => Promise<boolean> | undefined }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [kind, setKind] = useState<"Daily" | "Weekly">("Weekly");
  const [weekday, setWeekday] = useState(1); // Monday
  const [time, setTime] = useState("09:00");

  async function save() {
    const [hour, minute] = time.split(":").map(Number);
    const rule: RecurrenceRule = kind === "Daily" ? { Daily: { hour, minute } } : { Weekly: { weekday, hour, minute } };
    if (await onSave(rule)) {
      setSaved(true);
      setOpen(false);
    }
  }

  return (
    <Section
      title={t("cart.repeat.title")}
      right={
        <button onClick={() => setOpen((v) => !v)} className="text-xs font-semibold text-handshake-600">
          {open ? t("common.cancel") : saved ? t("common.edit") : t("cart.repeat.setUp")}
        </button>
      }
    >
      {saved && !open && <p className="text-xs text-presence-600">{t("cart.repeat.saved")}</p>}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-2">
            <SegmentedTabs label={t("cart.repeat.title")} tabs={[{ value: "Weekly", label: t("cart.repeat.weekly") }, { value: "Daily", label: t("cart.repeat.daily") }] as const} value={kind} onChange={setKind} />
            {kind === "Weekly" && (
              <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <option key={i} value={i}>
                    {new Date(2024, 0, 7 + i).toLocaleDateString(appLocale(), { weekday: "long" })}
                  </option>
                ))}
              </Select>
            )}
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            <p className="text-xs text-ink-400">{t("cart.repeat.detail")}</p>
            <Button loading={saving} disabled={busy} onClick={save} className="py-2 text-xs">
              {t("cart.repeat.save")}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}
