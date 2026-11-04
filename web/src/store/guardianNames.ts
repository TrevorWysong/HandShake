// What a person calls their guardians -- "Mum", "Sam from work" -- kept on
// this device, for that identity alone. A plan publishes only keys: who
// someone trusts with their account is nobody else's business -- including
// whoever else uses this device -- and a customer's name isn't public.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { identityStorage, perIdentity } from "./identityScope";

interface GuardianNames {
  /// Names by guardian key, base64.
  names: Record<string, string>;
  setName: (key: string, name: string) => void;
}

export const useGuardianNames = create<GuardianNames>()(
  persist(
    (set) => ({
      names: {},
      setName: (key, name) => set((state) => ({ names: { ...state.names, [key]: name.trim() } })),
    }),
    { name: "handshake.guardian-names.v1", storage: identityStorage() },
  ),
);
perIdentity(useGuardianNames);
