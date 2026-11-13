// A driver's delivery fee (`feeSchedule.ts`): a rate per mile or km, or up
// to ten distance bands, and what they ask past the last. A preview shows
// what an order of any distance comes to -- all a customer or store ever
// sees of it, in the driver's bid.
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Chip, Input, SegmentedTabs } from "../../components/ui";
import { centsTyped, currencySymbol, formatCents, fromMinorUnits } from "../../lib/ui/format";
import { useDriverSettings } from "../../store/roleSettings";
import { useT } from "../../i18n";
import { bandProblem, distanceIn, feeFor, KM_PER_MILE, MAX_BANDS, orderedBands, type DistanceUnit, type FeeBand, type FeeSchedule } from "../../lib/driving/feeSchedule";

export function FeeScheduleEditor() {
  const t = useT();
  const { fees, setFees, limits } = useDriverSettings();
  const unit = t(fees.unit === "mi" ? "fees.mi" : "fees.km");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 basis-40 text-[0.6875rem] text-ink-400">{t("fees.detail")}</p>
        <SegmentedTabs tabs={[{ value: "mi", label: t("fees.mi") }, { value: "km", label: t("fees.km") }] as const} value={fees.unit} onChange={(to) => setFees(inUnitOf(fees, to))} />
      </div>
      <SegmentedTabs tabs={[{ value: "rate", label: t("fees.perUnit", { unit }) }, { value: "bands", label: t("fees.byDistance") }] as const} value={fees.kind} onChange={(kind) => setFees({ kind })} />
      {fees.kind === "rate" ? (
        <div className="flex flex-wrap gap-3">
          <label className="min-w-0 flex-[1_1_8rem] text-xs font-semibold text-ink-500">
            {t("fees.base")}
            <Input type="number" min={0} step={0.5} value={fromMinorUnits(fees.baseCents)} onChange={(e) => setFees({ baseCents: centsTyped(e.target.value) })} prefix={currencySymbol()} className="mt-1 py-1.5 text-sm" />
          </label>
          <label className="min-w-0 flex-[1_1_8rem] text-xs font-semibold text-ink-500">
            {t("fees.rate", { unit })}
            <Input type="number" min={0} step={0.1} value={fromMinorUnits(fees.perUnitCents)} onChange={(e) => setFees({ perUnitCents: centsTyped(e.target.value) })} prefix={currencySymbol()} className="mt-1 py-1.5 text-sm" />
          </label>
        </div>
      ) : (
        <Bands fees={fees} unit={unit} onChange={setFees} />
      )}
      <div>
        <span className="block text-xs font-semibold text-ink-500">{t("fees.measure")}</span>
        <div className="mt-2 flex flex-wrap gap-2">
          <Chip active={fees.measure === "trip"} onClick={() => setFees({ measure: "trip" })}>{t("fees.trip")}</Chip>
          <Chip active={fees.measure === "delivery"} onClick={() => setFees({ measure: "delivery" })}>{t("fees.delivery")}</Chip>
        </div>
        <p className="mt-1.5 text-[0.6875rem] text-ink-400">{t(fees.measure === "trip" ? "fees.tripDetail" : "fees.deliveryDetail")}</p>
      </div>
      <Preview fees={fees} minFeeCents={limits.minFeeCents} unit={unit} />
    </div>
  );
}

/// The bands, each from where the one before ends, and what's asked past
/// the last.
function Bands({ fees, unit, onChange }: { fees: FeeSchedule; unit: string; onChange: (fees: Partial<FeeSchedule>) => void }) {
  const t = useT();
  const { bands } = fees;
  const setBand = (index: number, band: Partial<FeeBand>) => onChange({ bands: bands.map((b, i) => (i === index ? { ...b, ...band } : b)) });
  const last = orderedBands(bands).at(-1);
  return (
    <div className="flex flex-col gap-2">
      {bands.map((band, index) => {
          const from = orderedBands(bands.slice(0, index)).at(-1)?.upTo ?? 0;
          const problem = bandProblem(bands, index);
          return (
            <div key={index}>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="number"
                  min={0.1}
                  step={0.5}
                  value={band.upTo}
                  onChange={(e) => {
                    const upTo = distanceIn(e.target.valueAsNumber);
                    if (upTo !== null) setBand(index, { upTo });
                  }}
                  prefix={t("fees.from", { from: formatNumber(from) })}
                  suffix={unit}
                  aria-label={t("fees.upToLabel", { band: index + 1 })}
                  aria-invalid={problem !== null}
                  aria-describedby={problem ? `band-problem-${index}` : undefined}
                  className={`min-w-0 flex-[1_1_6.5rem] py-1.5 text-sm ${problem ? "ring-1 ring-red-400" : ""}`}
                />
                {/* Too narrow for both -- large text, a small phone -- the fee
                    and its remove button go to a line of their own. */}
                <div className="flex min-w-0 flex-[1_1_8rem] items-center gap-1">
                <Input type="number" min={0} step={0.5} value={fromMinorUnits(band.feeCents)} onChange={(e) => setBand(index, { feeCents: centsTyped(e.target.value) })} prefix={currencySymbol()} aria-label={t("fees.feeLabel", { band: index + 1 })} className="min-w-0 flex-1 py-1.5 text-sm" />
                <button
                  type="button"
                  onClick={() => onChange({ bands: bands.filter((_, i) => i !== index) })}
                  disabled={bands.length === 1}
                  aria-label={t("fees.remove", { band: index + 1 })}
                  className="grid h-10 w-10 place-items-center rounded-full text-ink-400 transition hover:bg-ink-100 hover:text-red-500 disabled:opacity-30 dark:hover:bg-ink-800"
                >
                  <Trash2 size={16} />
                </button>
                </div>
              </div>
              {problem && <p id={`band-problem-${index}`} className="mt-1 text-[0.6875rem] font-semibold text-red-500">{t("fees.pastPrevious", { distance: formatNumber(from), unit })}</p>}
            </div>
          );
        })}
      <button
        type="button"
        onClick={() => onChange({ bands: [...bands, nextBand(orderedBands(bands))] })}
        disabled={bands.length >= MAX_BANDS}
        className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-ink-200 py-2 text-xs font-semibold text-ink-500 transition hover:border-handshake-400 hover:text-handshake-600 disabled:opacity-40 dark:border-ink-700"
      >
        <Plus size={14} /> {t("fees.addBand")} <span className="font-normal text-ink-400">{t("fees.bandCount", { count: bands.length, max: MAX_BANDS })}</span>
      </button>
      {last && (
        <div className="mt-1">
          <span className="block text-xs font-semibold text-ink-500">{t("fees.beyond", { distance: formatNumber(last.upTo), unit })}</span>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Chip active={fees.beyondPerUnitCents === null} onClick={() => onChange({ beyondPerUnitCents: null })}>{t("fees.noBid")}</Chip>
            <Chip active={fees.beyondPerUnitCents !== null} onClick={() => onChange({ beyondPerUnitCents: fees.beyondPerUnitCents ?? fees.perUnitCents })}>{t("fees.extra", { unit })}</Chip>
            {fees.beyondPerUnitCents !== null && (
              <Input type="number" min={0} step={0.1} value={fromMinorUnits(fees.beyondPerUnitCents)} onChange={(e) => onChange({ beyondPerUnitCents: centsTyped(e.target.value) })} prefix={currencySymbol()} suffix={`/${unit}`} aria-label={t("fees.extra", { unit })} className="w-32 py-1.5 text-sm" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/// The band after the last: as far again as the last one ran, for as much
/// more as it asked over the one before.
function nextBand(bands: FeeBand[]): FeeBand {
  const [before, last] = [bands.at(-2), bands.at(-1)];
  if (!last) return { upTo: 3, feeCents: 400 };
  const step = last.upTo - (before?.upTo ?? 0);
  const raise = before ? Math.max(0, last.feeCents - before.feeCents) : 200;
  return { upTo: distanceIn(last.upTo + step) ?? last.upTo, feeCents: last.feeCents + raise };
}

/// What an order of any distance comes to: a step chart of the fee by
/// distance, scrubbed by the slider under it.
function Preview({ fees, minFeeCents, unit }: { fees: FeeSchedule; minFeeCents: number; unit: string }) {
  const t = useT();
  const span = previewSpan(fees);
  const [picked, setPicked] = useState<number | null>(null);
  const distance = Math.min(picked ?? span / 3, span);
  const fee = (d: number) => {
    const raw = feeFor(fees.unit === "mi" ? d * KM_PER_MILE : d, fees);
    return raw === null ? null : Math.max(raw, minFeeCents, 1);
  };
  const samples = Array.from({ length: SAMPLES + 1 }, (_, i) => (i / SAMPLES) * span);
  const values = samples.map(fee);
  const top = Math.max(1, ...values.map((f) => f ?? 0));
  const x = (d: number) => (d / span) * W;
  const y = (f: number) => H - 4 - (f / top) * (H - 12);
  // The line, broken where no fee is set.
  const path = samples.map((d, i) => (values[i] === null ? "" : `${i === 0 || values[i - 1] === null ? "M" : "L"}${x(d).toFixed(1)},${y(values[i]!).toFixed(1)}`)).join("");
  const now = fee(distance);
  return (
    <div className="rounded-2xl bg-ink-50 p-3 dark:bg-ink-800/50">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[0.6875rem] text-ink-400">{t("fees.previewFor", { distance: formatNumber(distance), unit })}</span>
        <span className="text-lg font-bold tabular-nums text-ink-900 dark:text-ink-50">{now === null ? t("fees.previewNoBid") : formatCents(now)}</span>
      </div>
      {/* The line stretches to the width; the marker sits over it, so it stays round. */}
      <div className="relative mt-2 h-16 text-handshake-500">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-hidden>
          <line x1={0} x2={W} y1={H - 4} y2={H - 4} className="stroke-ink-200 dark:stroke-ink-700" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {now !== null && <span className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-ink-50 forced-color-adjust-none dark:ring-ink-800 forced-colors:bg-[CanvasText]" style={{ left: `${(x(distance) / W) * 100}%`, top: `${(y(now) / H) * 100}%` }} aria-hidden />}
      </div>
      <input
        type="range"
        min={0}
        max={span}
        step={span / SAMPLES}
        value={distance}
        onChange={(e) => setPicked(e.target.valueAsNumber)}
        aria-label={t("fees.previewLabel", { unit })}
        aria-valuetext={`${formatNumber(distance)} ${unit}: ${now === null ? t("fees.previewNoBid") : formatCents(now)}`}
        className="mt-1 w-full accent-handshake-500"
      />
      <div className="flex justify-between text-[0.625rem] tabular-nums text-ink-400">
        <span>0 {unit}</span>
        <span>{formatNumber(span)} {unit}</span>
      </div>
    </div>
  );
}

const W = 300;
const H = 64;
const SAMPLES = 120;

/// How far the preview runs: past the last band by half again, or 15 of
/// the unit for a rate.
function previewSpan(fees: FeeSchedule): number {
  const last = orderedBands(fees.bands).at(-1)?.upTo;
  return fees.kind === "bands" && last ? Math.ceil(last * 1.5) : 15;
}

/// A schedule's distances and rates in another unit, so its fees stay the same.
function inUnitOf(fees: FeeSchedule, unit: DistanceUnit): Partial<FeeSchedule> {
  if (unit === fees.unit) return {};
  // How many of the new unit make one of the old.
  const per = unit === "km" ? KM_PER_MILE : 1 / KM_PER_MILE;
  const rate = (cents: number) => Math.round(cents / per);
  return {
    unit,
    perUnitCents: rate(fees.perUnitCents),
    beyondPerUnitCents: fees.beyondPerUnitCents === null ? null : rate(fees.beyondPerUnitCents),
    bands: fees.bands.map((b) => ({ ...b, upTo: distanceIn(b.upTo * per) ?? b.upTo })),
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}
