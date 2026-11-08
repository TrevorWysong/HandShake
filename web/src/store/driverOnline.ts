// Whether a driver's looking for orders: kept while the app runs, across its
// tabs, as a driver app keeps it -- and for that driver alone, so another
// identity signed in here starts offline. Never kept past a restart: nobody
// comes back to an app taking orders they'd forgotten about.
import { create } from "zustand";

export const useDriverOnline = create<{ driver: string | null; setOnline: (driver: string, online: boolean) => void }>((set) => ({
  driver: null,
  setOnline: (driver, online) => set({ driver: online ? driver : null }),
}));
