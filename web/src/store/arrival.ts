// This device receiving an account from another phone (docs/RECOVERY.md):
// the head its chain ended at as the old phone handed it over, from the
// sealed key, kept across the reload that follows. Until the app has
// checked its restored chain still ends there (`confirm_handover`), this
// device writes nothing -- its setup waits (`Arrival`) -- for if the old
// phone took the account back, it's the old phone's.
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ArrivalState {
  /// The head, base64, while the arrival is unconfirmed.
  head: string | null;
  arrive: (head: string) => void;
  /// Confirmed, or let go.
  clear: () => void;
}

export const useArrival = create<ArrivalState>()(
  persist(
    (set) => ({
      head: null,
      arrive: (head) => set({ head }),
      clear: () => set({ head: null }),
    }),
    { name: "handshake.arrival.v1" },
  ),
);
