// One payment agent per identity: the folder holding its state and keys is
// held by one process at a time. Two agents reading the same payments due
// could each authorize the same offer, one losing the race to record it --
// a hold nobody settles -- or save their state over each other's. So an
// agent holds its folder from its start to its stop, and a second one,
// started meanwhile, is refused rather than run alongside.
//
// The lock is a line of generations, `agent.lock.1`, `.2`, ...: the newest
// is the holder. Each is made whole, then put in place in one step that
// fails if that generation exists already (a hard link), so a reader never
// sees one half-written, and of two processes claiming the same generation
// exactly one does. A holder that died -- a crash, a power cut -- leaves its
// generation behind: a process finding it dead claims the next one, and only
// whoever claims it takes over. Each generation names its holder and a token
// of its own, and only its holder ever removes it. No two agents hold a
// folder at once, however they race to take over.
import { randomBytes } from "node:crypto";
import { link, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Refused } from "./engine.ts";

/// The lock's generations in an agent's folder: `agent.lock.<n>`.
export const LOCK_FILE = "agent.lock";

/// The folders this process holds: one process may run agents for several
/// identities (the dev host does), never two for one.
const held = new Set<string>();

/// What a generation says: who holds it, and its own token.
interface Holder {
  pid: number;
  token: string;
  since: number;
}

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

/// The generations in `dir`, newest first.
async function generations(dir: string): Promise<number[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const prefix = `${LOCK_FILE}.`;
  return names
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length)))
    .sort((a, b) => b - a);
}

/// The holder a generation names: `"gone"` if it went as it was read (its
/// holder let go, or it was tidied away), `"unreadable"` if it can't be read
/// -- never half-written, since each is put in place whole, so damaged.
async function holderOf(path: string): Promise<Holder | "gone" | "unreadable"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw err;
  }
  try {
    const holder = JSON.parse(text) as Partial<Holder>;
    return typeof holder.pid === "number" && typeof holder.token === "string" ? (holder as Holder) : "unreadable";
  } catch {
    return "unreadable";
  }
}

/// Puts `holder` in place as generation `path`, whole, in one step --
/// `false` if that generation is someone else's already.
async function claim(dir: string, path: string, holder: Holder): Promise<boolean> {
  const draft = join(dir, `${LOCK_FILE}.draft-${holder.token}`);
  const file = await open(draft, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(holder));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(draft, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await rm(draft, { force: true });
  }
}

/// Holds `dir` for this process until the returned release is called.
/// Refused while another running process holds it.
export async function holdFolder(dir: string, alive: (pid: number) => boolean = running): Promise<() => Promise<void>> {
  const refused = () => new Refused("Another payment agent is already running for this account. Close it, then try again.");
  if (held.has(dir)) throw refused();
  const holder: Holder = { pid: process.pid, token: randomBytes(16).toString("hex"), since: Date.now() };
  // Each pass either claims the next generation, or finds its holder alive.
  for (let attempt = 0; attempt < 16; attempt++) {
    const [newest] = await generations(dir);
    if (newest !== undefined) {
      const current = await holderOf(join(dir, `${LOCK_FILE}.${newest}`));
      if (current === "gone") continue;
      // A damaged one holds nothing: taken over like a dead holder's.
      if (current !== "unreadable" && current.pid !== process.pid && alive(current.pid)) throw refused();
    }
    // None, or one left by a process that's gone (or this one's id before a
    // restart, since it holds nothing here): claim the next.
    const generation = (newest ?? 0) + 1;
    const path = join(dir, `${LOCK_FILE}.${generation}`);
    if (!(await claim(dir, path, holder))) continue;
    held.add(dir);
    // Ours: the generations before it are their dead holders', tidied away.
    for (const earlier of await generations(dir)) if (earlier < generation) await rm(join(dir, `${LOCK_FILE}.${earlier}`), { force: true });
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      held.delete(dir);
      // Only ever our own generation, and only if it's still ours.
      const now = await holderOf(path);
      if (typeof now === "object" && now.token === holder.token) await rm(path, { force: true });
    };
  }
  throw new Refused("This account's payment agent couldn't take its folder. Try again in a moment.");
}
