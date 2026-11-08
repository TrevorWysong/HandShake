// An item's sale: a price, or a percent off; a name, if it has one; and when it
// runs, between dates, on days of the week, or both.
import { useState } from "react";
import clsx from "clsx";
import type { ItemSale, OpeningPeriod } from "../../../holochain/types";
import { MAX_LABEL_CHARS } from "../../../holochain/types";
import { Field, Input, Switch } from "../../../components/ui";
import { fromTimeInput, toTimeInput, WEEK } from "../../../lib/storefront/storeHours";
import { currencySymbol, fromMinorUnits, toMinorUnits, fromLocalDateTime, toLocalDateTime } from "../../../lib/ui/format";
import { useT, type MessageKey } from "../../../i18n";

const PERCENTS = [10, 15, 20, 25, 30, 50];
const DAY_NAME: Record<number, MessageKey> = { 0: "sale.day.0", 1: "sale.day.1", 2: "sale.day.2", 3: "sale.day.3", 4: "sale.day.4", 5: "sale.day.5", 6: "sale.day.6" };

export function SaleEditor({ value, fullCents, problem, onChange }: { value: ItemSale | null; fullCents: number; problem: string | null; onChange: (next: ItemSale | null) => void }) {
  const t = useT();
  const sale: ItemSale = value ?? { price_cents: 0, label: "", starts_at: null, ends_at: null, weekly: [] };
  const set = (patch: Partial<ItemSale>) => onChange({ ...sale, ...patch });
  const [dated, setDated] = useState(sale.starts_at !== null || sale.ends_at !== null);
  // One window, on the days picked: most sales are. Reads an existing schedule
  // by its first period, and is only written back when it's changed here.
  const first: OpeningPeriod | undefined = sale.weekly[0];
  const [weekly, setWeekly] = useState(sale.weekly.length > 0);
  const [days, setDays] = useState(() => [...new Set(sale.weekly.map((period) => period.weekday))]);
  const [from, setFrom] = useState(first ? toTimeInput(first.opens) : "15:00");
  const [to, setTo] = useState(first ? toTimeInput(first.closes) : "18:00");
  const writeWeek = (nextDays: number[], nextFrom: string, nextTo: string) => set({ weekly: nextDays.map((weekday) => ({ weekday, opens: fromTimeInput(nextFrom), closes: fromTimeInput(nextTo) })) });

  return (
    <div className="rounded-xl border border-ink-100 p-3 dark:border-ink-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("sale.title")}</p>
          <p className="text-xs text-ink-400">{t("sale.detail")}</p>
        </div>
        <Switch checked={!!value} onChange={(on) => onChange(on ? sale : null)} label={t("sale.title")} />
      </div>
      {value && (
        <div className="mt-3 flex flex-col gap-3">
          <Field label={t("sale.price")}>
            <Input type="number" min={0} step={0.5} value={sale.price_cents ? fromMinorUnits(sale.price_cents) : ""} onChange={(e) => set({ price_cents: toMinorUnits(Number(e.target.value)) })} prefix={currencySymbol()} />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {PERCENTS.map((percent) => {
              const cents = Math.round((fullCents * (100 - percent)) / 100);
              return (
                <button key={percent} type="button" disabled={fullCents <= 0} onClick={() => set({ price_cents: cents })} className={clsx("rounded-full px-3 py-1 text-xs font-semibold transition-colors", sale.price_cents === cents ? "bg-handshake-500 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700")}>
                  {t("sale.percentOff", { percent })}
                </button>
              );
            })}
          </div>
          <Input maxLength={MAX_LABEL_CHARS} value={sale.label} onChange={(e) => set({ label: e.target.value })} placeholder={t("sale.label")} aria-label={t("sale.label")} />

          <label className="flex items-center justify-between gap-3 text-sm font-medium text-ink-800 dark:text-ink-100">
            {t("sale.weekly")}
            <Switch
              checked={weekly}
              onChange={(on) => {
                setWeekly(on);
                if (!on) set({ weekly: [] });
              }}
              label={t("sale.weekly")}
            />
          </label>
          {weekly && (
            <div className="flex flex-col gap-2">
              <div role="group" aria-label={t("sale.days")} className="flex flex-wrap gap-1.5">
                {WEEK.map((weekday) => {
                  const on = days.includes(weekday);
                  return (
                    <button
                      key={weekday}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        const next = on ? days.filter((day) => day !== weekday) : [...days, weekday];
                        setDays(next);
                        writeWeek(next, from, to);
                      }}
                      className={clsx("rounded-full px-3 py-1.5 text-xs font-semibold transition-colors", on ? "bg-handshake-500 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-300")}
                    >
                      {t(DAY_NAME[weekday])}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <Field label={t("sale.from")} className="min-w-0 flex-1">
                  <Input type="time" value={from} onChange={(e) => { setFrom(e.target.value); writeWeek(days, e.target.value, to); }} />
                </Field>
                <Field label={t("sale.to")} className="min-w-0 flex-1">
                  <Input type="time" value={to} onChange={(e) => { setTo(e.target.value); writeWeek(days, from, e.target.value); }} />
                </Field>
              </div>
              <p className="text-[11px] text-ink-400">{t("sale.storeTime")}</p>
            </div>
          )}

          <label className="flex items-center justify-between gap-3 text-sm font-medium text-ink-800 dark:text-ink-100">
            {t("sale.dated")}
            <Switch
              checked={dated}
              onChange={(on) => {
                setDated(on);
                if (!on) set({ starts_at: null, ends_at: null });
              }}
              label={t("sale.dated")}
            />
          </label>
          {dated && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Field label={t("sale.startsAt")} className="min-w-0 flex-1">
                <Input type="datetime-local" value={toLocalDateTime(sale.starts_at)} onChange={(e) => set({ starts_at: fromLocalDateTime(e.target.value) })} />
              </Field>
              <Field label={t("sale.endsAt")} className="min-w-0 flex-1">
                <Input type="datetime-local" value={toLocalDateTime(sale.ends_at)} onChange={(e) => set({ ends_at: fromLocalDateTime(e.target.value) })} />
              </Field>
            </div>
          )}
          {problem && <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">{problem}</p>}
        </div>
      )}
    </div>
  );
}
