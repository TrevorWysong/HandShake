// Writing the agent's files -- its state, and its processor keys -- so a
// crash or power loss leaves the old file or the new one, never half of
// either: written beside it, flushed to disk, then renamed into place.
// Readable by their owner only.
import { chmod, mkdir, open, rename } from "node:fs/promises";
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
}
