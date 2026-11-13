// Which stores read "Farther away" while browsing: those well past the rest
// that deliver to the customer, whose drivers' fees, charged by distance,
// likely come to more. Judged among the stores shown, not by a fixed line.

/// Too few stores to say any is farther than the rest.
const FEWEST = 4;

/// Nearer than this is never far, however near the rest are.
const NEAR_KM = 3;

/// The distance past which a store is farther away than most -- twice the
/// median of `kms`, and at least `NEAR_KM` -- or `null` with too few to
/// compare.
export function fartherThanKm(kms: readonly number[]): number | null {
  if (kms.length < FEWEST) return null;
  const sorted = [...kms].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.max(2 * median, NEAR_KM);
}
