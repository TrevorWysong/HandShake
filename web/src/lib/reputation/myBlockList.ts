// The caller's own blocks (docs/REPUTATION.md, phase 4), held in the app: read
// once from their chain, and changed only by their own block or unblock --
// which update it here as they succeed -- so it's never stale, and screens
// that poll (a driver's feed) never read it again.
import { myBlocks } from "../../holochain/zomes/reputation";
import type { Party } from "../../holochain/types";
import { bytesToHex } from "../../holochain/decode";

const held = new Map<string, Promise<Party[]>>();

const keyOf = (by: Party) => ("Person" in by ? `p:${bytesToHex(by.Person)}` : `s:${bytesToHex(by.Store)}`);

/// Whom `by` (the caller, or a store of theirs) has blocked, most recent first.
export function myBlockList(by: Party): Promise<Party[]> {
  const key = keyOf(by);
  let list = held.get(key);
  if (!list) {
    list = myBlocks(by);
    held.set(key, list);
    // A read that fails is tried again next time, not held.
    list.catch(() => held.delete(key));
  }
  return list;
}

/// After the caller blocks or unblocks as `by`: read again next time.
export function blockListChanged(by: Party): void {
  held.delete(keyOf(by));
}
