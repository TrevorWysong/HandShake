import { useCallback, useRef, useState } from "react";
import L from "leaflet";
import { Clock } from "lucide-react";
import { baseMap } from "../../lib/places/baseMap";
import { DRIVER_PIN, HOME_PIN, STORE_PIN } from "../../lib/places/mapPins";
import { distanceKm } from "../../lib/places/geohash";
import { routePath } from "../../lib/driving/routing";
import { t as translate, useT } from "../../i18n";
import "leaflet/dist/leaflet.css";
import { PresenceDot } from "../ui";
import type { ActionHash, GeoPoint } from "../../holochain/types";
import { bytesEqual } from "../../holochain/decode";
import { useLatest, useLiveSignal } from "../../lib/hooks/useResource";

// A delivery on its way, as the big apps map it: the way by road from the
// driver -- through the store, until they've collected it -- to the door,
// only what's still ahead, under a pin that glides as the driver moves, and
// how long that's likely to take.
//
// Vanilla Leaflet, not react-leaflet: a thin, ref-based component, with the
// network's map tiles (`baseMap`) and road routes from the network's routing
// service (`routePath`, every point rounded to about 100 m). With no routing
// service, or no answer, the way is drawn as a plain dashed line -- not
// passed off as a route.

/// How far the driver moves before the way ahead is asked for again -- and
/// how soon, at the soonest: positions come from the driver's app, so their
/// pace isn't this one's to trust.
const REROUTE_KM = 0.15;
const REROUTE_MS = 15_000;
/// How long the pin takes to glide to each new position.
const GLIDE_MS = 1_000;

const ROUTE_COLOR = "#ff5a2b";

interface Props {
  /// The delivery whose driver's position this shows, as it arrives -- a
  /// live signal from that driver alone (holochain/live.ts). Until one does
  /// (or ever, if they don't share their location: a real, named
  /// limitation, not a hidden one), the map shows the way from the store.
  orderRef: ActionHash;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  /// The driver has the food: the way ahead no longer goes by the store.
  collected: boolean;
  className?: string;
}

export function LiveMap({ orderRef, pickup, dropoff, collected, className }: Props) {
  const t = useT();
  const mapRef = useRef<L.Map | null>(null);
  const routeRef = useRef<L.Layer[]>([]);
  const driverRef = useRef<{ marker: L.Marker; at: GeoPoint; frame: number } | null>(null);
  // Where the way ahead was last asked from, for which stage -- and which
  // ask is the latest, so a slow answer never draws over a newer one.
  const routedRef = useRef<{ from: GeoPoint; collected: boolean; at: number } | null>(null);
  const askRef = useRef(0);
  const collectedRef = useLatest(collected);
  const [live, setLive] = useState(false);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [fromLat, fromLon, toLat, toLon] = [pickup.lat, pickup.lon, dropoff.lat, dropoff.lon];

  /// Draws `points`' way: by road if there's an answer, else a dashed line.
  const route = useCallback(async (points: GeoPoint[], fit: boolean) => {
    const ask = ++askRef.current;
    const found = await routePath(points);
    const map = mapRef.current;
    if (!map || ask !== askRef.current) return;
    for (const layer of routeRef.current) layer.remove();
    const line: L.LatLngTuple[] = (found?.path ?? points).map((p) => [p.lat, p.lon]);
    routeRef.current = found
      ? [L.polyline(line, { color: "#fff", weight: 9, opacity: 0.95, lineCap: "round", lineJoin: "round" }), L.polyline(line, { color: ROUTE_COLOR, weight: 5, lineCap: "round", lineJoin: "round" })]
      : [L.polyline(line, { color: ROUTE_COLOR, weight: 3, opacity: 0.6, dashArray: "6 8" })];
    for (const layer of routeRef.current) layer.addTo(map);
    setMinutes(found ? Math.max(1, Math.ceil(found.minutes)) : null);
    if (fit) map.fitBounds(L.latLngBounds(line), { padding: [40, 40], maxZoom: 16 });
  }, []);

  // The map lives as long as its element: made as it mounts, removed with
  // it, and made again only for a different store or drop-off -- never as
  // the driver moves.
  const mountMap = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container) return;
      const map = baseMap(container);
      L.marker([fromLat, fromLon], { icon: STORE_PIN }).addTo(map).bindPopup(translate("cart.pickup"));
      L.marker([toLat, toLon], { icon: HOME_PIN }).addTo(map).bindPopup(translate("cart.dropoff"));
      map.fitBounds(L.latLngBounds([[fromLat, fromLon], [toLat, toLon]]), { padding: [40, 40], maxZoom: 16 });
      mapRef.current = map;
      void route([{ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon }], false);
      return () => {
        if (driverRef.current) cancelAnimationFrame(driverRef.current.frame);
        map.remove();
        mapRef.current = null;
        driverRef.current = null;
        routeRef.current = [];
        routedRef.current = null;
      };
    },
    [fromLat, fromLon, toLat, toLon, route],
  );

  // Each position the driver shares: the pin glides there, and the way
  // ahead is asked for again once they've moved on enough, or collected it.
  useLiveSignal((signal) => {
    if (!("LocationUpdate" in signal) || !bytesEqual(signal.LocationUpdate.order_ref, orderRef)) return;
    const map = mapRef.current;
    if (!map) return;
    const to: GeoPoint = { lat: signal.LocationUpdate.lat, lon: signal.LocationUpdate.lon };
    const first = !driverRef.current;
    if (driverRef.current) glide(driverRef.current, to);
    else driverRef.current = { marker: L.marker([to.lat, to.lon], { icon: DRIVER_PIN, zIndexOffset: 1000 }).addTo(map), at: to, frame: 0 };
    setLive(true);
    const routed = routedRef.current;
    const stage = collectedRef.current;
    const now = Date.now();
    if (!routed || routed.collected !== stage || (distanceKm(routed.from, to) >= REROUTE_KM && now - routed.at >= REROUTE_MS)) {
      routedRef.current = { from: to, collected: stage, at: now };
      void route(stage ? [to, dropoff] : [to, pickup, dropoff], first);
    }
  });

  return (
    <div>
      <div className="relative overflow-hidden rounded-2xl border border-ink-100 shadow-[var(--shadow-card)] dark:border-ink-800">
        <div ref={mountMap} className={className ?? "h-56 w-full lg:h-80"} />
        {live && (
          <div className="pointer-events-none absolute left-2 top-2 z-[400] flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-bold text-ink-700 shadow backdrop-blur-sm dark:bg-ink-900/90 dark:text-ink-200">
            <PresenceDot />
            {t("map.live")}
          </div>
        )}
        {live && minutes !== null && (
          <div className="pointer-events-none absolute right-2 top-2 z-[400] flex items-center gap-1.5 rounded-full bg-ink-900/90 px-3 py-1.5 text-xs font-bold text-white shadow backdrop-blur-sm dark:bg-white/90 dark:text-ink-900">
            <Clock size={13} />
            {t("map.minutesAway", { minutes })}
          </div>
        )}
      </div>
      {!live && <p className="mt-1 text-center text-xs text-ink-400">{t("order.waitingLocation")}</p>}
    </div>
  );
}

/// Moves `driver`'s pin to `to` over `GLIDE_MS`, from wherever it is now.
function glide(driver: { marker: L.Marker; at: GeoPoint; frame: number }, to: GeoPoint): void {
  cancelAnimationFrame(driver.frame);
  driver.at = to;
  // Asked for less motion: it's simply there.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return void driver.marker.setLatLng([to.lat, to.lon]);
  const from = driver.marker.getLatLng();
  const start = performance.now();
  const step = (now: number) => {
    const done = Math.min(1, (now - start) / GLIDE_MS);
    const eased = 1 - (1 - done) ** 3;
    driver.marker.setLatLng([from.lat + (to.lat - from.lat) * eased, from.lng + (to.lon - from.lng) * eased]);
    if (done < 1) driver.frame = requestAnimationFrame(step);
  };
  driver.frame = requestAnimationFrame(step);
}
