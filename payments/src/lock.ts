// One payment agent per identity: the folder holding its state and keys is
// held by one process at a time. Two agents reading the same payments due
// could each authorize the same offer, one losing the race to record it --
// a hold nobody settles -- or save their state over each other's. So an
// agent holds its folder from its start to its stop, and a second one,
// started meanwhile, is refused rather than run alongside.
//
// The lock is a file made only if it doesn't exist (`O_EXCL`), naming the
// process holding it. A process that died holding it -- a crash, a power
// cut -- leaves it behind: one naming a process no longer running is taken
// over, so a crash never locks an account out.
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Refused } from "./engine.ts";

/// The lock file in an agent's folder.
export const LOCK_FILE = "agent.lock";

/// The folders this process holds: one process may run agents for several
/// identities (the dev host does), never two for one.
const held = new Set<string>();

/// Whether a process `pid` is running here.
export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // There, but not ours to signal: running all the same.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/// The process a lock file names -- `undefined` if it's unreadable or
/// half-written.
async function holderOf(path: string): Promise<number | undefined> {
  try {
    const pid = (JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

/// Holds `dir` for this process until the returned release is called.
/// Refused while another running process holds it.
export async function holdFolder(dir: string, alive: (pid: number) => boolean = running): Promise<() => Promise<void>> {
  const path = join(dir, LOCK_FILE);
  if (held.has(path)) throw new Refused("Another payment agent is already running for this account. Close it, then try again.");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, since: Date.now() }));
        await file.sync();
      } finally {
        await file.close();
      }
      held.add(path);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        held.delete(path);
        await rm(path, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await holderOf(path);
      if (typeof holder === "number" && holder !== process.pid && alive(holder)) {
        throw new Refused("Another payment agent is already running for this account. Close it, then try again.");
      }
      // Left by a process that's gone -- or by this one's id before a
      // restart, since it holds nothing under it -- or half-written as it
      // died: taken over.
      await rm(path, { force: true });
    }
  }
  throw new Refused("This account's payment agent couldn't take its folder. Try again in a moment.");
}
