// This device's own settings -- not the agent's: they belong to the device
// (a store's tablet rings; the owner's phone may not), so they're kept in
// this browser, not on the DHT.
import { create } from "zustand";
import { persist } from "zustand/middleware";

/// How the app looks: as the device does, or always light or dark.
export type Theme = "system" | "light" | "dark";

interface Preferences {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /// System notifications for order updates (needs the browser's permission).
  notifications: boolean;
  /// A chime for each new order waiting on one of this device's stores.
  newOrderChime: boolean;
  setNotifications: (on: boolean) => void;
  setNewOrderChime: (on: boolean) => void;
}

export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
      notifications: false,
      newOrderChime: true,
      setNotifications: (notifications) => set({ notifications }),
      setNewOrderChime: (newOrderChime) => set({ newOrderChime }),
    }),
    { name: "handshake.preferences.v1" },
  ),
);
