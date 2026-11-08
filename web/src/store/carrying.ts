// The deliveries a driver is carrying, read for the whole app: what has to
// happen while they carry one -- sharing where they are with its customer --
// runs on every screen, and their dashboard shows them without reading again.
// Kept for that driver alone, while the app runs.
import { create } from "zustand";
import { fetchActiveDeliveries } from "../lib/driving/feed";
import type { OrderRow } from "../lib/driving/deliveryRows";
import { forEachIdentity } from "./identityScope";

const NONE = { driver: null as string | null, rows: undefined as OrderRow[] | undefined };

export const useCarrying = create(() => NONE);

/// Reads what `driver` is carrying now.
export async function refreshCarrying(driver: string): Promise<void> {
  const rows = await fetchActiveDeliveries();
  useCarrying.setState({ driver, rows });
}

forEachIdentity(() => useCarrying.setState(NONE));
