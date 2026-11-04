// What the app keeps for whoever is signed in -- their cart, their settings,
// what they call their guardians, the offers they've sent -- on a device
// several identities may share. Each such store keeps its saved copy under
// the identity's own key, and is emptied and read back for the new identity
// whenever another signs in: nothing of one person's ever shows to another.
//
// A store opts in with `identityStorage()` (its saved copy) and
// `perIdentity()` (cleared on a change); one with nothing saved, only
// `forEachIdentity()`. The session says who's signed in (`signedIn`).
import { createJSONStorage, type PersistStorage } from "zustand/middleware";
import type { StoreApi } from "zustand";
import { forget, readStored, store } from "../lib/util/storage";

/// The signed-in identity's key (hex) -- `null` while nobody is, or while
/// the stores are being cleared for another.
let current: string | null = null;
const resets: (() => void)[] = [];
const reloads: (() => unknown)[] = [];

/// Where a store's saved copy is kept: this device's storage, under the
/// signed-in identity's key. Nothing is read or written while nobody is.
export function identityStorage<S>(options?: Parameters<typeof createJSONStorage>[1]): PersistStorage<S> | undefined {
  return createJSONStorage<S>(
    () => ({
      getItem: (name) => {
        // A copy kept before stores were per identity is nobody's in
        // particular -- whoever used the device last: it's dropped.
        forget(name);
        return current ? readStored(`${name}:${current}`) : null;
      },
      setItem: (name, value) => {
        if (current) store(`${name}:${current}`, value);
      },
      removeItem: (name) => {
        if (current) forget(`${name}:${current}`);
      },
    }),
    options,
  );
}

/// Runs `reset` whenever another identity signs in: for what's kept only in
/// memory.
export function forEachIdentity(reset: () => void): void {
  resets.push(reset);
}

/// A store saved with `identityStorage`: back to its initial state when
/// another identity signs in, then theirs, read back.
export function perIdentity<T>(api: StoreApi<T> & { persist: { rehydrate: () => unknown } }): void {
  resets.push(() => api.setState(api.getInitialState(), true));
  reloads.push(() => api.persist.rehydrate());
}

/// Who's signed in now (`null`: nobody). Every per-identity store is cleared
/// -- with nothing written, so neither identity's saved copy changes -- and
/// then reads back the new identity's.
export function signedIn(identity: string | null): void {
  if (identity === current) return;
  current = null;
  for (const reset of resets) reset();
  current = identity;
  if (identity) for (const reload of reloads) void reload();
}

