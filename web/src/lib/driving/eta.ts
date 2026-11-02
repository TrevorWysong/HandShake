// How long a delivery would take a driver, for the ETAs their bid states:
// there to the store, waiting if the kitchen won't be ready yet, then on to
// the drop-off -- each leg by road, as the network's routing service
// (`routing.ts`) times it. A store starts cooking a delivery once its
// driver commits, so before then the food's ready its quoted prep time
// after the driver's bid would be accepted -- about now.
import type { GeoPoint } from "../../holochain/types";
import { distanceKm } from "../places/geohash";

export interface Trip {
  /// Minutes by road: the driver to the store, and the store to the drop-off.
  toStoreMinutes: number;
  toDropoffMinutes: number;
  /// When the kitchen says the order will be ready (microseconds), once it's
  /// cooking.
  readyBy: number | null;
  /// The prep time the store quoted, for an order it hasn't started.
  prepMinutes: number | null;
  /// Now, in milliseconds.
  nowMs: number;
}

/// A bid's two ETAs, in whole minutes -- each at least one.
export interface TripEstimate {
  /// Until the driver reaches the store: when they'd be due there.
  toStoreMinutes: number;
  /// Until they'd hand the order over.
  etaMinutes: number;
}

export function estimateTrip(trip: Trip): TripEstimate {
  const untilReady = trip.readyBy !== null ? Math.max(0, (trip.readyBy / 1000 - trip.nowMs) / 60_000) : (trip.prepMinutes ?? 0);
  const toStoreMinutes = Math.max(1, Math.ceil(trip.toStoreMinutes));
  return { toStoreMinutes, etaMinutes: Math.max(toStoreMinutes, Math.ceil(Math.max(trip.toStoreMinutes, untilReady) + trip.toDropoffMinutes)) };
}

/// How long a driver usually takes to reach the store once they've taken
/// the order, in minutes -- the spread of an estimate before one has.
const PICKUP_SPREAD_MINUTES = 10;

/// What a restaurant card says before ordering: "25–35 min" and how far the
/// store is -- its prep time (with any busy extra), then the drive to the
/// customer by road, rounded to five minutes, with the spread of a driver
/// getting there. Without a drive time, only how far.
export function deliveryEstimate(store: { location: GeoPoint; prep_minutes: number; busy_extra_minutes: number }, customer: GeoPoint, driveMinutes: number | null): { km: number; fromMinutes: number | null; toMinutes: number | null } {
  const km = distanceKm(store.location, customer);
  if (driveMinutes === null) return { km, fromMinutes: null, toMinutes: null };
  const fromMinutes = Math.max(5, Math.round((store.prep_minutes + store.busy_extra_minutes + driveMinutes) / 5) * 5);
  return { km, fromMinutes, toMinutes: fromMinutes + PICKUP_SPREAD_MINUTES };
}
