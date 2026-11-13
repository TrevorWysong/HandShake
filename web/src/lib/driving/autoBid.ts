// What a driver's fee schedule (`feeSchedule.ts`) asks for an order, and
// their automatic bid on one they're offered: that fee, never under their
// lowest, and never over the customer's cap (an order capped below it gets
// no bid). The ETAs are timed by road (`routing.ts`, `estimateTrip`); an
// order the routing service can't time gets no automatic bid.
import type { GeoPoint } from "../../holochain/types";
import type { AutoBid } from "../../store/roleSettings";
import { distanceKm } from "../places/geohash";
import { feeFor, type FeeSchedule } from "./feeSchedule";

/// Where an order's trip goes: from the driver, to its store, on to its drop-off.
export interface TripPoints {
  driver: GeoPoint;
  store: GeoPoint;
  dropoff: GeoPoint;
}

/// The distance an order is charged on, and its fee by the driver's schedule.
export interface Quote {
  km: number;
  feeCents: number;
}

/// What the driver's schedule asks for an order -- at least their lowest fee,
/// and never nothing (the network refuses a bid of zero) -- or `null` past
/// their last band with nothing set beyond it.
export function quote(points: TripPoints, schedule: FeeSchedule, minFeeCents: number): Quote | null {
  const delivery = distanceKm(points.store, points.dropoff);
  const km = schedule.measure === "trip" ? distanceKm(points.driver, points.store) + delivery : delivery;
  const fee = feeFor(km, schedule);
  return fee === null ? null : { km, feeCents: Math.max(minFeeCents, fee, 1) };
}

/// The fee to bid automatically, or `null` with no quote or a customer's
/// cap (`capCents`) below it.
export function autoBidPrice(quoted: Quote | null, capCents: number | null): number | null {
  if (quoted === null) return null;
  return capCents !== null && quoted.feeCents > capCents ? null : quoted.feeCents;
}

/// Whether the driver's rule skips a store, by its drivers' reports of
/// refusing to check them in.
export function skipsStore(checkInRefusals: number, rule: AutoBid): boolean {
  return checkInRefusals >= rule.skipRefusals;
}
