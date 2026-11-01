// Sharing a driver's position from a screen: the sharing itself lives
// outside React (lib/driving/locationShare.ts); this only says, for as long
// as the screen shows a delivery, that it's one to share with. Keyed by the
// order's hex -- a string, so a poll that rebuilds the order's bytes never
// restarts it.
import { useEffect } from "react";
import { sendLocationUpdate } from "../../holochain/live";
import { hexToBytes } from "../../holochain/decode";
import { locationSharer } from "../driving/locationShare";

const shareLocation = locationSharer(typeof navigator !== "undefined" && "geolocation" in navigator ? navigator.geolocation : undefined, (orderHex, lat, lon) =>
  sendLocationUpdate(hexToBytes(orderHex), lat, lon),
);

/// Shares the driver's position with `orderHex`'s customer while mounted;
/// `null` shares nothing.
export function useLocationSharing(orderHex: string | null): void {
  useEffect(() => (orderHex ? shareLocation(orderHex) : undefined), [orderHex]);
}
