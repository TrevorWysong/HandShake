// Where a payee's processor keys are kept: on their own device, never on
// the network, never in the app's pages. The desktop app keeps them with
// the operating system's keystore (Electron `safeStorage`); development
// keeps them in a file only its owner can read. Anything else that can
// keep a secret fits the same two calls.
import { readFile, rm } from "node:fs/promises";
import { writeAtomically } from "./files.ts";
import type { Connection } from "./processor.ts";
import type { ProcessorName } from "./types.ts";

/// The keys for one processor account, and what connecting found.
export interface Credentials {
  processor: ProcessorName;
  keys: Record<string, string>;
  connection: Connection;
}

export interface CredentialStore {
  load(): Promise<Credentials | null>;
  save(credentials: Credentials): Promise<void>;
  clear(): Promise<void>;
}

/// Encrypts and decrypts with a key the store never sees (the keystore's).
export interface Sealer {
  seal(plain: string): Promise<Buffer>;
  open(sealed: Buffer): Promise<string>;
}

/// Credentials in a file only its owner can read -- sealed by `sealer`
/// where there's a keystore to seal with, and replaced whole or not at all.
export function fileCredentials(path: string, sealer: Sealer | null = null): CredentialStore {
  return {
    async load() {
      try {
        const bytes = await readFile(path);
        return JSON.parse(sealer ? await sealer.open(bytes) : bytes.toString("utf8")) as Credentials;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async save(credentials) {
      const json = JSON.stringify(credentials);
      await writeAtomically(path, sealer ? await sealer.seal(json) : json);
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}

/// Credentials in memory, for tests.
export function memoryCredentials(): CredentialStore {
  let kept: Credentials | null = null;
  return {
    load: async () => kept,
    save: async (credentials) => void (kept = structuredClone(credentials)),
    clear: async () => void (kept = null),
  };
}
