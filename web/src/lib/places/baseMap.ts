import L from "leaflet";
import { networkServices } from "../../store/network";
import { safeAttribution } from "./attribution";

/// The network's map tiles, on a new map in `container`.
export function baseMap(container: HTMLElement): L.Map {
  const map = L.map(container, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
  const services = networkServices();
  L.tileLayer(services.map_tiles_url, { maxZoom: 19, attribution: safeAttribution(services.map_attribution) }).addTo(map);
  return map;
}
