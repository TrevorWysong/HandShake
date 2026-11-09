// Where an online driver is, as their device says -- kept on this device, and
// used only to choose which map cells their feed looks in and how far orders
// are (`DriverFeed`, their dashboard). Never sent: drivers find orders, nobody
// finds drivers. Without it -- location off, refused or not to be had -- their
// saved address stands in.
import { create } from "zustand";
import type { GeoPoint } from "../holochain/types";
import { forEachIdentity } from "./identityScope";

interface DriverPosition {
  point: GeoPoint | null;
  /// They've refused this app their location.
  refused: boolean;
}

const UNKNOWN: DriverPosition = { point: null, refused: false };

export const useDriverPosition = create<DriverPosition>(() => UNKNOWN);

/// Follows the device's position while it's wanted, coarsely -- a map cell
/// is a kilometre or so -- and lets go of it after. Returns the stop.
export function watchDriverPosition(): () => void {
  const geolocation = typeof navigator !== "undefined" ? navigator.geolocation : undefined;
  if (!geolocation) return () => undefined;
  const id = geolocation.watchPosition(
    ({ coords }) => useDriverPosition.setState({ point: { lat: coords.latitude, lon: coords.longitude }, refused: false }),
    (error) => useDriverPosition.setState({ point: null, refused: error.code === error.PERMISSION_DENIED }),
    { maximumAge: 60_000, timeout: 30_000 },
  );
  return () => {
    geolocation.clearWatch(id);
    useDriverPosition.setState(UNKNOWN);
  };
}

/// Where an online driver's feed looks: where they are, or their saved address.
export const useDriverLocation = (saved: GeoPoint) => useDriverPosition((s) => s.point) ?? saved;

forEachIdentity(() => useDriverPosition.setState(UNKNOWN));
