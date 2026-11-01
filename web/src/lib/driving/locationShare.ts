// A driver's live position, shared with the customers of the deliveries
// they're carrying -- outside React, so no render can restart it. One watch
// on the device's position serves every delivery: it starts when the first
// one shares, and stops when the last one stops.
//
// Throttled here (nothing on the network can rate-limit a direct signal --
// see holochain/live.ts), and silently inert if the device has no location
// or the driver denies it. Named, not hidden: a driver who never grants
// location access simply never appears on the customer's live map --
// everything else about the delivery still works.

/// How often each customer hears where their driver is, at most.
export const SHARE_EVERY_MS = 8000;

type Send = (orderHex: string, lat: number, lon: number) => Promise<void>;

/// A sharer over `geolocation` that sends with `send` -- the app has one
/// (`shareLocation`); tests make their own.
export function locationSharer(geolocation: Geolocation | undefined, send: Send, now: () => number = Date.now) {
  // Each delivery sharing, with how many are asking (a screen that mounts
  // twice asks twice), and when its customer last heard.
  const sharing = new Map<string, { holders: number; lastSent: number }>();
  let watch: number | null = null;

  function sendAll(position: GeolocationPosition) {
    const at = now();
    for (const [orderHex, share] of sharing) {
      if (at - share.lastSent < SHARE_EVERY_MS) continue;
      share.lastSent = at;
      send(orderHex, position.coords.latitude, position.coords.longitude).catch(() => {});
    }
  }

  /// Shares the device's position with `orderHex`'s customer until the
  /// returned function is called.
  return function share(orderHex: string): () => void {
    if (!geolocation) return () => {};
    const share = sharing.get(orderHex);
    if (share) share.holders++;
    else sharing.set(orderHex, { holders: 1, lastSent: -Infinity });
    watch ??= geolocation.watchPosition(sendAll, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const share = sharing.get(orderHex)!;
      if (--share.holders === 0) sharing.delete(orderHex);
      if (sharing.size === 0 && watch !== null) {
        geolocation.clearWatch(watch);
        watch = null;
      }
    };
  };
}
