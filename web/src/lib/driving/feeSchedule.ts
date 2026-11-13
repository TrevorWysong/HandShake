// A driver's delivery fee, as they set it: a rate per mile or km, or a fee
// for each distance band -- "$4 up to 3 mi, $6 from 3 to 6 mi" -- with what
// they ask past the last one. Kept on the driver's device: a customer or
// store only ever sees the fee it comes to for their order, in the bid.
// The network bounds every bid regardless -- never zero, never over the
// customer's cap (`integrity/src/bids.rs`).

export type DistanceUnit = "km" | "mi";

export const KM_PER_MILE = 1.609344;

/// The most bands a schedule holds.
export const MAX_BANDS = 10;

/// The farthest a band may reach, in its unit -- past any delivery.
export const MAX_BAND_DISTANCE = 500;

export interface FeeBand {
  /// Where the band ends, in the schedule's unit: it starts where the one
  /// before ends, the first at zero.
  upTo: number;
  feeCents: number;
}

export interface FeeSchedule {
  kind: "rate" | "bands";
  unit: DistanceUnit;
  /// What distance it's charged on: the whole trip -- from where the driver
  /// is to the store, then on to the drop-off -- or only the store to the
  /// drop-off.
  measure: "trip" | "delivery";
  /// A rate's flat part, on every order.
  baseCents: number;
  /// A rate's charge per unit.
  perUnitCents: number;
  bands: FeeBand[];
  /// Past the last band: this per unit beyond it, on top of its fee -- or
  /// `null` for no fee at all, so no automatic bid.
  beyondPerUnitCents: number | null;
}

/// A schedule to start from, in `unit`: a rate, as a trip's distance.
export function defaultSchedule(unit: DistanceUnit): FeeSchedule {
  const perUnitCents = unit === "mi" ? 150 : 100;
  return {
    kind: "rate",
    unit,
    measure: "trip",
    baseCents: 0,
    perUnitCents,
    bands: [
      { upTo: 3, feeCents: 400 },
      { upTo: 6, feeCents: 600 },
      { upTo: 10, feeCents: 900 },
    ],
    beyondPerUnitCents: perUnitCents,
  };
}

/// The bands that count, in order: those that end past the one before. A
/// band typed out of order shows as such in the editor (`bandProblem`), and
/// is left out until it's put right.
export function orderedBands(bands: readonly FeeBand[]): FeeBand[] {
  const out: FeeBand[] = [];
  for (const band of bands) {
    if (band.upTo > (out.at(-1)?.upTo ?? 0)) out.push(band);
  }
  return out;
}

/// Why a band can't be used as it stands, if it can't: it must end past the
/// band before it.
export function bandProblem(bands: readonly FeeBand[], index: number): "notPastPrevious" | null {
  return bands[index].upTo > (orderedBands(bands.slice(0, index)).at(-1)?.upTo ?? 0) ? null : "notPastPrevious";
}

/// The fee for a distance of `km`, in minor units -- or `null` past the last
/// band when nothing is set beyond it.
export function feeFor(km: number, schedule: FeeSchedule): number | null {
  const distance = inUnit(km, schedule.unit);
  if (schedule.kind === "rate") return schedule.baseCents + upToCent(distance * schedule.perUnitCents);
  const bands = orderedBands(schedule.bands);
  const band = bands.find((b) => distance <= b.upTo);
  if (band) return band.feeCents;
  const last = bands.at(-1);
  if (!last || schedule.beyondPerUnitCents === null) return null;
  return last.feeCents + upToCent((distance - last.upTo) * schedule.beyondPerUnitCents);
}

/// A part of a minor unit, rounded up -- but not a conversion's rounding
/// error: 4 mi is 4 mi, not a hair over.
function upToCent(amount: number): number {
  return Math.ceil(amount - 1e-6);
}

/// A schedule as it was saved, made sound: each amount a whole, non-negative
/// number of minor units, each distance within bounds, at most `MAX_BANDS`.
/// Anything unreadable takes `fallback`'s value.
export function soundSchedule(saved: unknown, fallback: FeeSchedule): FeeSchedule {
  const s = (saved ?? {}) as Partial<Record<keyof FeeSchedule, unknown>>;
  const unit = s.unit === "km" || s.unit === "mi" ? s.unit : fallback.unit;
  const bands = Array.isArray(s.bands)
    ? s.bands.slice(0, MAX_BANDS).flatMap((b: Partial<Record<keyof FeeBand, unknown>>) => {
        const upTo = distanceIn(b?.upTo);
        const feeCents = cents(b?.feeCents);
        return upTo === null || feeCents === null ? [] : [{ upTo, feeCents }];
      })
    : fallback.bands;
  return {
    kind: s.kind === "rate" || s.kind === "bands" ? s.kind : fallback.kind,
    unit,
    measure: s.measure === "trip" || s.measure === "delivery" ? s.measure : fallback.measure,
    baseCents: cents(s.baseCents) ?? fallback.baseCents,
    perUnitCents: cents(s.perUnitCents) ?? fallback.perUnitCents,
    bands,
    beyondPerUnitCents: s.beyondPerUnitCents === null ? null : (cents(s.beyondPerUnitCents) ?? fallback.beyondPerUnitCents),
  };
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), Number.MAX_SAFE_INTEGER) : null;
}

/// A band's end as typed: within (0, `MAX_BAND_DISTANCE`], to a tenth.
export function distanceIn(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const distance = Math.min(Math.round(value * 10) / 10, MAX_BAND_DISTANCE);
  return distance > 0 ? distance : null;
}

/// A distance in km as `unit`.
export function inUnit(km: number, unit: DistanceUnit): number {
  return unit === "mi" ? km / KM_PER_MILE : km;
}
