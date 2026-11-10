import { Link } from "react-router-dom";
import { Clock, Heart, Tag } from "lucide-react";
import { motion } from "framer-motion";
import type { GeoPoint, MerchantCatalog } from "../../holochain/types";
import { deliveryEstimate } from "../../lib/driving/eta";
import { formatDistance } from "../../lib/ui/format";
import { bytesToHex } from "../../holochain/decode";
import { Badge } from "../ui";
import { StarRating } from "../StarRating";
import { fadeSlideUp } from "../../lib/ui/motion";
import clsx from "clsx";
import { storeStatus } from "../../lib/storefront/storeHours";
import { StoreArt } from "./StoreArt";
import { useT } from "../../i18n";

interface Props {
  catalogHash: Uint8Array;
  catalog: MerchantCatalog;
  /// What "open now" is judged against -- the list's clock.
  now: Date;
  rating?: number;
  reviewCount?: number;
  /// Where the customer is: the card shows how long delivery takes, and how
  /// far the store is.
  customer?: GeoPoint;
  /// How long the drive from the store to the customer takes by road, when
  /// the network's routing service says.
  driveMinutes?: number | null;
  /// Both omitted means "no favorite affordance at all" -- `Browse` is the
  /// only caller that currently passes these, since it's the only place
  /// that already holds the full favorited-set fetched once up front.
  favorited?: boolean;
  onToggleFavorite?: () => void;
  /// It has a deal on, for someone looking for one.
  deal?: boolean;
}

export function RestaurantCard({ catalogHash, catalog, now, rating, reviewCount, customer, driveMinutes = null, favorited, onToggleFavorite, deal = false }: Props) {
  const t = useT();
  const status = storeStatus(catalog, now);
  const estimate = customer ? deliveryEstimate(catalog, customer, driveMinutes) : null;
  // Farther than the store delivers: it's there to collect from.
  const pickupOnly = !!estimate && estimate.km > catalog.max_delivery_radius_km;
  const hex = bytesToHex(catalogHash);

  return (
    // `catalog` has no single-fetch extern on the backend (only the
    // nearby-list one) -- passed via router state so the detail screen
    // doesn't need a redundant round trip for data it already has, with a
    // list re-fetch as its own fallback for a direct URL/refresh.
    <motion.div variants={fadeSlideUp} whileHover={{ y: -3 }} transition={{ duration: 0.18 }} className="group">
      <Link to={`/customer/merchant/${hex}`} state={{ catalog, catalogHash }} className="block overflow-hidden rounded-2xl shadow-[var(--shadow-card)]">
        <div className="relative h-32 overflow-hidden rounded-t-2xl">
          {catalog.banner_data_uri ? (
            <img
              src={catalog.banner_data_uri}
              alt=""
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          ) : (
            <StoreArt storeHex={hex} cuisine={catalog.cuisine_type} className="h-full text-5xl transition duration-300 group-hover:scale-105" />
          )}
          {!status.open && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <Badge tone="neutral">{t("hours.closed")}</Badge>
            </div>
          )}
          {deal && (
            <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-full bg-handshake-500 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
              <Tag size={10} /> {t("card.deal")}
            </span>
          )}
          {onToggleFavorite && (
            <motion.button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleFavorite();
              }}
              whileTap={{ scale: 0.85 }}
              aria-label={t(favorited ? "store.unfavorite" : "store.favorite")}
              aria-pressed={favorited}
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm transition hover:bg-black/60"
            >
              <Heart size={14} fill={favorited ? "currentColor" : "none"} className={favorited ? "text-red-400" : undefined} />
            </motion.button>
          )}
        </div>
        <div className="rounded-b-2xl border border-t-0 border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-3">
          <p className="truncate font-bold text-sm">{catalog.business_name}</p>
          <div className="mt-1 flex items-center gap-3 text-xs text-ink-400">
            {rating !== undefined && reviewCount ? <StarRating value={rating} count={reviewCount} size={11} /> : !catalog.cuisine_type && <span>{t("card.new")}</span>}
            {catalog.cuisine_type && <span className="truncate">{catalog.cuisine_type}</span>}
          </div>
          <p className={clsx("mt-1 flex min-w-0 items-center gap-1 truncate text-xs", status.open ? "text-presence-600" : "text-ink-400")}>
            <Clock size={11} className="shrink-0" />
            <span className="truncate">
              {status.open && pickupOnly ? t("card.pickupOnly") : status.open && estimate?.fromMinutes ? `${estimate.fromMinutes}–${estimate.toMinutes} min` : status.label}
              {estimate && <span className="text-ink-400"> · {formatDistance(estimate.km)}</span>}
            </span>
          </p>
        </div>
      </Link>
    </motion.div>
  );
}
