// What's on offer near a driver while they're online -- read by the app
// shell's feed (`DriverFeed`) whichever screen they're on, shown by their
// dashboard. Held for that driver alone, while the app runs.
import { create } from "zustand";
import { bytesToHex } from "../holochain/decode";
import type { OrderRow } from "../lib/driving/deliveryRows";
import { forEachIdentity } from "./identityScope";

interface DriverFeedState {
  /// Whose feed it is, and where it was read.
  driver: string | null;
  geohash: string | null;
  /// `undefined` until the first read since going online.
  offered: OrderRow[] | undefined;
  /// Every order offered since going online, by hex: what's news and what isn't.
  seen: ReadonlySet<string>;
  /// How many came while they were looking elsewhere -- the Dash tab's badge.
  unseen: number;
}

const OFFLINE: DriverFeedState = { driver: null, geohash: null, offered: undefined, seen: new Set(), unseen: 0 };

export const useDriverFeed = create<DriverFeedState>(() => OFFLINE);

/// Going online, or off: a fresh feed, or none.
export function resetFeed(driver: string | null): void {
  useDriverFeed.setState({ ...OFFLINE, driver });
}

/// A read of the feed: holds what it offers, and returns how many are new.
/// The first read after going online is what's there already -- none of it
/// news. `looking` is whether they're on their dashboard to see them.
export function feedRead(driver: string, geohash: string, offered: OrderRow[], looking: boolean): number {
  const state = useDriverFeed.getState();
  if (state.driver !== driver) return 0;
  const hexes = offered.map(({ hash }) => bytesToHex(hash));
  const fresh = state.offered === undefined ? 0 : hexes.filter((hex) => !state.seen.has(hex)).length;
  useDriverFeed.setState({ geohash, offered, seen: new Set([...state.seen, ...hexes]), unseen: looking ? 0 : state.unseen + fresh });
  return fresh;
}

forEachIdentity(() => useDriverFeed.setState(OFFLINE));
