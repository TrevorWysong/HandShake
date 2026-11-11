// Writing the agent's files -- its state, and its processor keys -- so a
// crash or power loss leaves the old file or the new one, never half of
// either: written beside it, flushed to disk, renamed into place, and the
// rename itself flushed with its folder. Readable by their owner only.
// Deleting one is flushed the same way, so keys a payee disconnected can't
// come back after a power cut -- and with them the account they cut off.
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeAtomically(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.next`;
  const file = await open(next, "w", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  // An umask can't widen it.
  await chmod(next, 0o600);
  await rename(next, path);
  await syncFolder(dirname(path));
}

/// Deletes `path`, if it's there, for good.
export async function removeDurably(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncFolder(dirname(path)).catch((err: NodeJS.ErrnoException) => {
    // No folder, nothing to flush: the file never was.
    if (err.code !== "ENOENT") throw err;
  });
}

/// Flushes a folder's entries -- a rename or a delete in it -- to disk.
/// Windows can't open a folder to flush it, and its file system journals
/// renames and deletes itself.
async function syncFolder(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const folder = await open(dir, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}
