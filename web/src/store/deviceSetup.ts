// This device's setup (each zome's `prepare_device`): the grants that let
// signals and handoff codes reach it, and its background work. A device set
// up at sign-up already is; one that received its account from another
// phone isn't, so the app sets it up on every start. Each part runs on its
// own -- one's trouble never stops the others -- and a part that fails is
// tried again, then shown as incomplete with a way to try again, never
// left silently missing.
import { create } from "zustand";
import { callZome } from "../holochain/client";
import { retrying } from "../lib/network/retry";

/// The zomes with something to set up on a device.
export const DEVICE_SETUP_ZOMES = ["dispatch", "attestation", "rewards"] as const;
type Part = (typeof DEVICE_SETUP_ZOMES)[number];

/// How long between tries of a part that failed.
const SETUP_RETRIES_MS = [2_000, 5_000, 15_000] as const;

interface DeviceSetupState {
  /// The parts that still couldn't be set up, after their retries.
  incomplete: Part[];
  /// A setup under way.
  running: boolean;
  setUp: () => Promise<Part[]>;
}

/// Sets each of `parts` up with `prepare`, each on its own and each tried
/// again on failure: the ones that still fail.
export async function setUpParts(parts: readonly Part[], prepare: (part: Part) => Promise<void>, delaysMs: readonly number[] = SETUP_RETRIES_MS): Promise<Part[]> {
  const outcomes = await Promise.allSettled(parts.map((part) => retrying(() => prepare(part), delaysMs)));
  return parts.filter((_, i) => outcomes[i].status === "rejected");
}

export const useDeviceSetup = create<DeviceSetupState>((set, get) => ({
  incomplete: [],
  running: false,
  setUp: async () => {
    if (get().running) return get().incomplete;
    set({ running: true });
    const incomplete = await setUpParts(DEVICE_SETUP_ZOMES, (zome) => callZome(zome, "prepare_device", null));
    set({ incomplete, running: false });
    return incomplete;
  },
}));
