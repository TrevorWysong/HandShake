// Who's bringing the order, as Uber Eats and DoorDash show it: the driver's
// name, photo and rating, and -- once they've set off -- the car to look
// for, its plate and photo. The vehicle is the driver's own, sealed to this
// customer alone (`get_driver_vehicle`); a driver on foot or a bike may have
// none to share.
import { Car } from "lucide-react";
import { getDriverVehicle } from "../../holochain/zomes/dispatch";
import { bytesToHex } from "../../holochain/decode";
import type { ActionHash, AgentPubKey, DeliveryStatus } from "../../holochain/types";
import { fetchDriverStats } from "../../lib/driving/driverStats";
import { useResource } from "../../lib/hooks/useResource";
import { POLL, isOrderSignal } from "../../lib/network/poll";
import { shortAgentId } from "../../lib/ui/format";
import { useT } from "../../i18n";
import { StarRating } from "../StarRating";
import { DriverFaults } from "../reputation/DriverFaults";
import { DriverBlock } from "../reputation/DriverBlock";
import { Card, Skeleton } from "../ui";

interface Props {
  orderRef: ActionHash;
  driver: AgentPubKey;
  status: DeliveryStatus;
}

export function YourDriver({ orderRef, driver, status }: Props) {
  const t = useT();
  const driverHex = bytesToHex(driver);
  const { data: stats } = useResource(`driver-stats:${driverHex}`, () => fetchDriverStats(driver));
  // Asked again as the order moves on: it's shared as the driver commits.
  const { data: vehicle } = useResource(`driver-vehicle:${bytesToHex(orderRef)}:${driverHex}:${status}`, () => getDriverVehicle(orderRef), { pollMs: POLL.signalled, refreshOn: isOrderSignal });

  if (!stats) return <Skeleton className="h-20 w-full rounded-2xl" />;
  const name = stats.displayName ?? shortAgentId(driver);
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        {stats.avatar ? (
          <img src={stats.avatar} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover ring-2 ring-white dark:ring-ink-900" />
        ) : (
          <div aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-handshake-100 text-lg font-bold text-handshake-700 dark:bg-handshake-900/40 dark:text-handshake-300">
            {name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("driver.yours")}</p>
          <p className="flex items-center gap-1 text-base font-bold text-ink-900 dark:text-ink-50"><span className="truncate">{name}</span><DriverBlock driver={driver} name={name} /></p>
          <div className="flex items-center gap-2 text-xs text-ink-500 dark:text-ink-400">
            {stats.reviewCount > 0 && <StarRating value={stats.avgRating} count={stats.reviewCount} size={11} />}
            <span>{t("driver.deliveries", { count: stats.completedCount })}</span>
            {stats.faultedCount > 0 && <DriverFaults driver={driver} count={stats.faultedCount} />}
          </div>
        </div>
        {vehicle?.photo_data_uri && <img src={vehicle.photo_data_uri} alt={vehicle.vehicle_description} className="h-12 w-16 shrink-0 rounded-xl object-cover" />}
      </div>
      {vehicle && (
        <div className="mt-3 flex items-center gap-3 rounded-xl bg-ink-50 px-3 py-2.5 dark:bg-ink-800/60">
          <Car size={18} className="shrink-0 text-ink-500 dark:text-ink-400" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-800 dark:text-ink-100">{vehicle.vehicle_description}</p>
          {vehicle.license_plate && (
            <span aria-label={t("driver.plate", { plate: vehicle.license_plate })} className="shrink-0 rounded-md border-2 border-ink-800 bg-white px-2 py-0.5 font-mono text-xs font-bold tracking-widest text-ink-900 dark:border-ink-200">
              {vehicle.license_plate.toUpperCase()}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
