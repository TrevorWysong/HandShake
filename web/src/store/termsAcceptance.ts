// Which terms of use this device has agreed to. It's the device's, kept here
// rather than on the network: agreeing comes before any account exists, and a
// public record of it would add nothing the person needs.
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface TermsAcceptance {
  acceptedVersion: string | null;
  accept: (version: string) => void;
}

export const useTermsAcceptance = create<TermsAcceptance>()(
  persist(
    (set) => ({
      acceptedVersion: null,
      accept: (acceptedVersion) => set({ acceptedVersion }),
    }),
    { name: "handshake.terms.v1" },
  ),
);
