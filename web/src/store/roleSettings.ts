// What a person has chosen for themselves in a role: a customer's usual
// checkout, a driver's own limits. Each only ever narrows that person's own
// choices -- nobody else relies on them, and the network enforces its own
// rules regardless -- so they're kept on this device, per identity.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { identityStorage, perIdentity } from "./identityScope";
import type { DropoffPreference } from "../holochain/types";
import type { TravelMode } from "../lib/driving/routing";
import { defaultSchedule, soundSchedule, type FeeSchedule } from "../lib/driving/feeSchedule";
import { usesMiles } from "../lib/ui/format";

/// A customer's checkout as they last left it, offered again next time.
export interface CheckoutDefaults {
  /// A tip percentage, or `null` for an amount they typed.
  tipPercent: number | null;
  /// The fee cap they chose, in minor units.
  feeCapCents: number | null;
  dropoffPreference: DropoffPreference;
  priority: boolean;
  /// Whether their app picks a driver from the bids, by the network's rule.
  autoMatch: boolean;
}

interface CustomerSettings {
  checkout: CheckoutDefaults;
  rememberCheckout: (checkout: CheckoutDefaults) => void;
}

export const useCustomerSettings = create<CustomerSettings>()(
  persist(
    (set) => ({
      checkout: { tipPercent: 15, feeCapCents: null, dropoffPreference: "HandToMe", priority: false, autoMatch: true },
      rememberCheckout: (checkout) => set({ checkout }),
    }),
    // Checkout defaults saved before a field existed take its default.
    {
      name: "handshake.customer-settings.v1",
      storage: identityStorage(),
      merge: (saved, current) => {
        const stored = saved as Partial<CustomerSettings> | undefined;
        return { ...current, checkout: { ...current.checkout, ...stored?.checkout } };
      },
    },
  ),
);

/// A driver's own limits on what they're offered -- within the network's.
export interface DriverLimits {
  /// The most orders they'll carry at once; `null` for the network's limit.
  maxAtOnce: number | null;
  /// Whether they're offered priority orders.
  takePriority: boolean;
  /// The lowest fee cap they'll see an order for, in minor units.
  minFeeCents: number;
  /// How near one of their drop-offs an add-on may go, in km; `null` for the
  /// network's suggestion.
  detourKm: number | null;
}

/// The add-on distances a driver can pick from, in km.
export const DETOUR_CHOICES_KM = [0.5, 1, 2, 3, 5];

/// A driver's rule for bidding automatically, as the big apps offer orders:
/// on every order they're offered, at their fee (`FeeSchedule`).
export interface AutoBid {
  on: boolean;
  /// Stores they skip: those with at least this many drivers' reports of
  /// refusing to check them in.
  skipRefusals: number;
}

interface DriverSettings {
  limits: DriverLimits;
  /// What they charge: by distance, for automatic bids and as the fee a bid
  /// starts at.
  fees: FeeSchedule;
  setFees: (fees: Partial<FeeSchedule>) => void;
  autoBid: AutoBid;
  setAutoBid: (autoBid: Partial<AutoBid>) => void;
  /// How they get around -- which roads their bids' ETAs are timed on
  /// (`routing.ts`).
  travelMode: TravelMode;
  setLimits: (limits: Partial<DriverLimits>) => void;
  setTravelMode: (mode: TravelMode) => void;
}

export const useDriverSettings = create<DriverSettings>()(
  persist(
    (set) => ({
      limits: { maxAtOnce: null, takePriority: true, minFeeCents: 0, detourKm: null },
      fees: defaultSchedule(usesMiles() ? "mi" : "km"),
      setFees: (fees) => set((state) => ({ fees: { ...state.fees, ...fees } })),
      autoBid: { on: false, skipRefusals: 3 },
      setAutoBid: (autoBid) => set((state) => ({ autoBid: { ...state.autoBid, ...autoBid } })),
      travelMode: "car",
      setLimits: (limits) => set((state) => ({ limits: { ...state.limits, ...limits } })),
      setTravelMode: (travelMode) => set({ travelMode }),
    }),
    // Settings saved before a field existed take its default; a rate per km
    // from before fee schedules becomes one.
    {
      name: "handshake.driver-settings.v1",
      storage: identityStorage(),
      merge: (saved, current) => {
        const stored = saved as (Partial<DriverSettings> & { autoBid?: { perKmCents?: number } }) | undefined;
        const { perKmCents, ...autoBid } = stored?.autoBid ?? {};
        const before = stored?.fees ?? (perKmCents !== undefined ? { kind: "rate", unit: "km", perUnitCents: perKmCents } : undefined);
        return { ...current, ...stored, limits: { ...current.limits, ...stored?.limits }, fees: soundSchedule(before, current.fees), autoBid: { ...current.autoBid, ...autoBid } };
      },
    },
  ),
);
perIdentity(useCustomerSettings);
perIdentity(useDriverSettings);
