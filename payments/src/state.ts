// What the agent remembers between rounds, on the payee's own device only:
// the processor's ids for cards payers saved here, the authorizations a
// card's bank challenged (to resume once the payer answers), which card took
// each store's first-order deal, and recent attempts (to stop card testing
// through the payee's account). None of it is a secret -- the processor
// keys are kept apart (`credentials.ts`) -- but it's nobody else's, so the
// file is the owner's alone.
import { readFile } from "node:fs/promises";
import { writeAtomically } from "./files.ts";

export interface State {
  /// The processor's id for each payer's saved card, by payer (hex).
  saved: Record<string, string>;
  /// When each saved card was last kept or used (ms), by payer (hex): one
  /// unused for `SAVED_CARD_MS` is deleted.
  savedAt: Record<string, number>;
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
  /// The processor account the saved cards above were kept with
  /// (`accountId`): another account can't charge them.
  account: string | null;
  /// The account each hold was placed with, by its reference: it's settled
  /// or refunded there and nowhere else.
  heldWith: Record<string, string>;
  /// The account holds placed before they were bound to one (`heldWith`)
  /// belong to: the one this agent ran first after it began binding them.
  legacy: string | null;
}

export const emptyState = (): State => ({ saved: {}, savedAt: {}, challenged: {}, newcomers: {}, attempts: {}, known: {}, declines: [], account: null, heldWith: {}, legacy: null });

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

/// State in a JSON file readable by its owner only, replaced whole or not
/// at all (`writeAtomically`).
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
      await writeAtomically(path, JSON.stringify(state));
    },
  };
}
