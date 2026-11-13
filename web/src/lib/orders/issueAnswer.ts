// What a store's answer to a customer's report can be: a refund of all the
// report is worth, of a part of it, or none -- and, with any of them, points
// as an apology. Validation holds a part between nothing and all of it
// (`integrity/src/issues.rs`); a grant to between 1 and `MAX_GRANT_POINTS`.
import { MAX_GRANT_POINTS, type Reward } from "../../holochain/types";

/// The parts offered at a tap: a quarter, half and three quarters of
/// `value`, each a whole minor unit, more than nothing and less than all of
/// it -- however small the report.
export function quickParts(value: number): number[] {
  return [...new Set([25, 50, 75].map((percent) => Math.floor((value * percent) / 100)))].filter((part) => part > 0 && part < value);
}

/// A part as typed, in minor units: what the store can refund, or `null`
/// for nothing, all of it or more (that's a decline or a full refund).
export function partIn(cents: number, value: number): number | null {
  return Number.isInteger(cents) && cents > 0 && cents < value ? cents : null;
}

/// Points offered at a tap: what the store's cheapest rewards cost -- so a
/// store can give "enough for a free coffee" -- or round amounts for a
/// program with none.
export function goodwillChoices(rewards: readonly Reward[]): { points: number; reward: string | null }[] {
  const priced = [...rewards]
    .filter((r) => r.cost > 0 && r.cost <= MAX_GRANT_POINTS)
    .sort((a, b) => a.cost - b.cost)
    .filter((r, i, all) => i === 0 || all[i - 1].cost !== r.cost)
    .slice(0, 3)
    .map((r) => ({ points: r.cost, reward: r.name }));
  return priced.length > 0 ? priced : [50, 100, 250].map((points) => ({ points, reward: null }));
}

/// Points as typed: a whole number between 1 and `MAX_GRANT_POINTS`, or
/// `null`.
export function pointsIn(value: number): number | null {
  return Number.isInteger(value) && value >= 1 && value <= MAX_GRANT_POINTS ? value : null;
}

/// The points picked: what was chosen or typed, or the first choice.
export function pickedPoints(program: { rewards: readonly Reward[] }, points: number | null): number | null {
  return points ?? goodwillChoices(program.rewards)[0]?.points ?? null;
}
