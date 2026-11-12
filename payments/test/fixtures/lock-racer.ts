// One process racing others to hold a folder (lock.test.ts): waits for the
// start, tries, and says how it went. A winner holds on for a while, checks
// its lock is still its own, then lets go.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { holdFolder } from "../../src/lock.ts";

const [dir, startAt] = [process.argv[2], Number(process.argv[3])];
await new Promise((go) => setTimeout(go, Math.max(0, startAt - Date.now())));
try {
  const release = await holdFolder(dir);
  console.log("won");
  await new Promise((wait) => setTimeout(wait, 1_000));
  const mine = [];
  for (const name of await readdir(dir)) {
    if (/^agent\.lock\.\d+$/.test(name) && JSON.parse(await readFile(join(dir, name), "utf8")).pid === process.pid) mine.push(name);
  }
  console.log(mine.length === 1 ? "kept" : `lost (${mine.length})`);
  await release();
} catch (err) {
  console.log(/already running/.test(String(err)) ? "refused" : `error: ${String(err)}`);
}
