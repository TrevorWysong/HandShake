// What the agent remembers between rounds, on the payee's own device only:
// the processor's ids for cards payers saved here, the authorizations a
// card's bank challenged (to resume once the payer answers), which card took
// each store's first-order deal, and recent attempts (to stop card testing
// through the payee's account). None of it is a secret -- the processor
// keys are kept apart (`credentials.ts`) -- but it's nobody else's, so the
// file is the owner's alone.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface State {
  /// The processor's id for each payer's saved card, by payer (hex).
  saved: Record<string, string>;
  /// A challenged authorization's reference, by the challenge's action (hex).
  challenged: Record<string, string>;
  /// Each store's first-order deal: the order (hex) each card fingerprint
  /// took it on, by store (hex), then fingerprint.
  newcomers: Record<string, Record<string, string>>;
  /// Each recent offer the agent tried on its processor, by offer (hex):
  /// whose, for which order, and when (ms).
  attempts: Record<string, { payer: string; order: string; at: number }>;
  /// Payers (hex) whose card this payee has held before.
  known: Record<string, true>;
  /// When each recent decline of a new payer's card was (ms): a burst of
  /// them is cards being tested, and pauses new payers for a while.
  declines: number[];
}

export const emptyState = (): State => ({ saved: {}, challenged: {}, newcomers: {}, attempts: {}, known: {}, declines: [] });

export interface StateStore {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}

/// State in memory: for tests, and a runtime that keeps it elsewhere.
export function memoryStore(initial: State = emptyState()): StateStore {
  let state = structuredClone(initial);
  return {
    load: async () => structuredClone(state),
    save: async (next) => void (state = structuredClone(next)),
  };
}

/// State in a JSON file readable by its owner only, written whole and
/// renamed into place, so a crash never leaves half of it.
export function fileStore(path: string): StateStore {
  return {
    async load() {
      try {
        return { ...emptyState(), ...(JSON.parse(await readFile(path, "utf8")) as Partial<State>) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
        throw err;
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const next = `${path}.next`;
      await writeFile(next, JSON.stringify(state), { mode: 0o600 });
      await chmod(next, 0o600);
      await rename(next, path);
    },
  };
}
