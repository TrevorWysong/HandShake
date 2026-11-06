import { useCallback, useRef, useState } from "react";
import L from "leaflet";
import { baseMap, emojiIcon } from "../../lib/places/baseMap";
import { t as translate } from "../../i18n";
import "leaflet/dist/leaflet.css";
import { PresenceDot } from "../ui";
import type { ActionHash, GeoPoint } from "../../holochain/types";
import { bytesEqual } from "../../holochain/decode";
import { useLiveSignal } from "../../lib/hooks/useResource";

// Vanilla Leaflet, not react-leaflet -- this app already writes small,
// self-contained components (StarRating, AddressSearch, ChatPanel) rather
// than pulling in wrapper libraries, and a thin imperative ref-based
// component sidesteps any react-leaflet/React-19 peer-dependency question
// entirely. Tiles come from the public OpenStreetMap raster endpoint --
// no API key, no vendor account, consistent with this project's "0
// overhead" stance on infrastructure costs --
// the same provider `AddressSearch`'s Nominatim-backed geocoding uses.

const PICKUP_ICON = emojiIcon("🏪");
const DROPOFF_ICON = emojiIcon("🏁");
const DRIVER_ICON = emojiIcon("🛵");

interface Props {
  /// The delivery whose driver's position this shows, as it arrives -- a
  /// live signal from that driver alone (holochain/live.ts). Until one does
  /// (or ever, if they don't share their location: a real, named
  /// limitation, not a hidden one), the map shows where the food's coming
  /// from and going.
  orderRef: ActionHash;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  className?: string;
}

export function LiveMap({ orderRef, pickup, dropoff, className }: Props) {
  const mapRef = useRef<L.Map | null>(null);
  const driverMarkerRef = useRef<L.Marker | null>(null);
  const [live, setLive] = useState(false);
  const [fromLat, fromLon, toLat, toLon] = [pickup.lat, pickup.lon, dropoff.lat, dropoff.lon];

  // The map lives as long as its element: made as it mounts, removed with
  // it, and made again only for a different pickup or drop-off -- never as
  // the driver moves.
  const mountMap = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container) return;
      const map = baseMap(container);
      L.marker([fromLat, fromLon], { icon: PICKUP_ICON }).addTo(map).bindPopup(translate("cart.pickup"));
      L.marker([toLat, toLon], { icon: DROPOFF_ICON }).addTo(map).bindPopup(translate("cart.dropoff"));
      // A themed, dashed connector rather than a bare pair of pins -- gives
      // the route a visual through-line in the brand color without claiming
      // to be a real routed path (it's a straight line, not turn-by-turn).
      L.polyline(
        [
          [fromLat, fromLon],
          [toLat, toLon],
        ],
        { color: "#ff5a2b", weight: 3, opacity: 0.55, dashArray: "6 8" },
      ).addTo(map);
      map.fitBounds(
        L.latLngBounds([
          [fromLat, fromLon],
          [toLat, toLon],
        ]),
        { padding: [32, 32], maxZoom: 16 },
      );
      mapRef.current = map;
      return () => {
        map.remove();
        mapRef.current = null;
        driverMarkerRef.current = null;
      };
    },
    [fromLat, fromLon, toLat, toLon],
  );

  // The driver's pin moves as each position arrives.
  useLiveSignal((signal) => {
    if (!("LocationUpdate" in signal) || !bytesEqual(signal.LocationUpdate.order_ref, orderRef)) return;
    const map = mapRef.current;
    if (!map) return;
    const at: L.LatLngTuple = [signal.LocationUpdate.lat, signal.LocationUpdate.lon];
    if (driverMarkerRef.current) driverMarkerRef.current.setLatLng(at);
    else driverMarkerRef.current = L.marker(at, { icon: DRIVER_ICON }).addTo(map);
    setLive(true);
  });

  return (
    <div>
      <div className="relative overflow-hidden rounded-2xl border border-ink-100 dark:border-ink-800 shadow-[var(--shadow-card)]">
        <div ref={mountMap} className={className ?? "h-56 w-full lg:h-80"} />
        {live && (
          <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-white/90 dark:bg-ink-900/90 px-2.5 py-1 text-[10px] font-bold text-ink-700 dark:text-ink-200 shadow backdrop-blur-sm">
            <PresenceDot />
            {translate("map.live")}
          </div>
        )}
      </div>
      {!live && <p className="mt-1 text-center text-xs text-ink-400">{translate("order.waitingLocation")}</p>}
    </div>
  );
}
