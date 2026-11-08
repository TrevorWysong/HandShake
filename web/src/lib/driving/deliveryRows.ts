// A driver's deliveries as their dashboard lays them out: each order's row,
// where it's going, and the stages it moves through on their side.
import type { Bid, DeliveryOrder, DeliveryStatus, DropoffDetails, GeoPoint } from "../../holochain/types";
import { geohashCenter } from "../places/geohash";

// Live location is only meaningful once the driver has committed and is
// moving on this delivery. Every 8s: a few seconds, not sub-second -- fast
// enough to feel live, far below anything that would stress signal
// delivery the way a tighter interval could.
export const TRACKED_STATUSES: DeliveryStatus[] = ["DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore", "PickedUp"];
/// Before the driver has the food -- when they can still drop a delivery.
export const BEFORE_PICKUP: DeliveryStatus[] = ["BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore"];
/// On the way to the store, not yet checked in.
export const ON_THE_WAY: DeliveryStatus[] = ["DriverEnRouteToMerchant", "MerchantConfirmed"];

export interface OrderRow {
  /// The order's identity (its original action) -- what every order call takes.
  hash: Uint8Array;
  order: DeliveryOrder;
  bid?: Bid;
  /// The exact drop-off -- opened only for the driver whose bid was
  /// accepted; an open order has just its area (`dropoff_geohash`).
  dropoff?: DropoffDetails | null;
}

/// Where an order's drop-off is, as precisely as this driver may know it.
export function dropoffPoint(row: OrderRow): GeoPoint {
  return row.dropoff?.point ?? geohashCenter(row.order.dropoff_geohash);
}
