import { useCallback, useState } from "react";
import { MapPin } from "lucide-react";
import L from "leaflet";
import { baseMap } from "../../lib/places/baseMap";
import { STORE_PIN } from "../../lib/places/mapPins";
import type { GeoPoint } from "../../holochain/types";
import { useT } from "../../i18n";


/// Where a store is. The map's asked for only when it's tapped: its tile
/// server would otherwise learn which stores a person looks at.
export function StoreMap({ location }: { location: GeoPoint }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const mountMap = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container) return;
      const map = baseMap(container);
      L.marker([location.lat, location.lon], { icon: STORE_PIN }).addTo(map);
      map.setView([location.lat, location.lon], 15);
      return () => {
        map.remove();
      };
    },
    [location.lat, location.lon],
  );
  if (shown) return <div ref={mountMap} className="h-48 overflow-hidden rounded-2xl border border-ink-100 md:h-56 dark:border-ink-800" />;
  return (
    <button type="button" onClick={() => setShown(true)} className="flex h-24 w-full flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-ink-200 bg-ink-100/50 text-ink-500 transition hover:border-ink-300 hover:bg-ink-100 dark:border-ink-700 dark:bg-ink-800/40 dark:text-ink-300 dark:hover:bg-ink-800">
      <span className="flex items-center gap-1.5 text-sm font-semibold"><MapPin size={15} /> {t("storeInfo.showMap")}</span>
      <span className="px-4 text-center text-[11px] text-ink-400">{t("storeInfo.mapPrivacy")}</span>
    </button>
  );
}
