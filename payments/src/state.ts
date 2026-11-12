// What the agent remembers between rounds, on the payee's own device only:
// the processor's ids for cards payers saved here, the authorizations a
// card's bank challenged (to resume once the payer answers), which card took
// each store's first-order deal, and recent attempts (to stop card testing
// through the payee's account). None of it is a secret -- the processor
// keys are kept apart (`credentials.ts`) -- but it's nobody else's, so the
// file is the owner's alone.
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { holdFolder } from "./lock.ts";
import { writeAtomically } from "./files.ts";

export interface State {
  /// The processor's id for each payer's saved card, by payer (hex).
  saved: Record<string, string>;
  /// When each saved card was last kept or used (ms), by payer (hex): one
  /// unused for `SAVED_CARD_MS` is deleted.
  savedAt: Record<string, number>;
  /// A challenged authorization's reference, by the challenge's action (hex).
  challenged: Record<string, string>;
  /// When each challenge was made (ms), by its action (hex): one older than
  /// an authorization can live is forgotten.
  challengedAt: Record<string, number>;
  /// First-order deal cards kept here by an agent from before they were
  /// kept on the network (`claim_newcomer_card`): the order (hex) each card
  /// fingerprint took it on, by store (hex). Claimed on the network on the
  /// next round, then emptied.
  newcomers: Record<string, Record<string, string>>;
  /// Each recent offer the agent tried on its processor, by offer (hex):
  /// whose, for which order, and when (ms).
  attempts: Record<string, { payer: string; order: string; at: number }>;
  /// Payers (hex) whose card this payee has held before.
  known: Record<string, true>;
  /// When each recent decline of a card from a payer with no history was
  /// (ms): a burst of them is cards being tested, and asks such payers for
  /// work.
  declines: number[];
  /// The busy record payers with no history do work for while cards are
  /// being tested here (hex), what it asks, how many doublings past the
  /// network's first ask, and until when (ms) -- or `null`.
  busy: { record: string; bits: number; level: number; until: number } | null;
  /// The processor account the saved cards above were kept with
  /// (`accountId`): another account can't charge them.
  account: string | null;
  /// The account each hold was placed with, by its reference: it's settled
  /// or refunded there and nowhere else.
  heldWith: Record<string, string>;
  /// When each hold was placed (ms), by its reference: forgotten once no
  /// refund could reach it (`HELD_KEPT_MS`).
  heldAt: Record<string, number>;
  /// The account holds placed before they were bound to one (`heldWith`)
  /// belong to: the one this agent ran first after it began binding them.
  legacy: string | null;
}

export const emptyState = (): State => ({ saved: {}, savedAt: {}, challenged: {}, challengedAt: {}, newcomers: {}, attempts: {}, known: {}, declines: [], busy: null, account: null, heldWith: {}, heldAt: {}, legacy: null });

export interface StateStore {
  load(): Promise<State>;
  save(state: State): Promise<void>;
  /// Holds the state for this agent alone, until the release is called --
  /// refused while another agent holds it (`lock.ts`). A store only one
  /// agent can reach has nothing to hold.
  hold?(): Promise<() => Promise<void>>;
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
    async hold() {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      return holdFolder(dirname(path));
    },
  };
}
