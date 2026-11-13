// Blocks as the records they apply to carry them (docs/REPUTATION.md, phase
// 4; `handshake_types::block_prints`): salted fingerprints, so only someone
// who already knows a key can test for it. The customer's app finds itself
// in a store's listing here -- from the listing it already has, no read of
// its own.
import type { MerchantCatalog, Party } from "../../holochain/types";
import { bytesEqual } from "../../holochain/decode";

const DOMAIN = new TextEncoder().encode("handshake-block:v1:");
const PRINT_BYTES = 32;

/// `sha256(DOMAIN || salt || key)` -- the same as the network computes.
export async function blockPrint(salt: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(DOMAIN.length + salt.length + key.length);
  input.set(DOMAIN, 0);
  input.set(salt, DOMAIN.length);
  input.set(key, DOMAIN.length + salt.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

/// Whether `list` holds the fingerprint of `key` under `salt`.
export async function listsKey(list: Uint8Array, salt: Uint8Array, key: Uint8Array): Promise<boolean> {
  if (list.length === 0) return false;
  // Bytes, however they were decoded.
  const bytes = Uint8Array.from(list);
  const print = await blockPrint(Uint8Array.from(salt), key);
  for (let at = 0; at + PRINT_BYTES <= bytes.length; at += PRINT_BYTES) {
    if (bytesEqual(bytes.subarray(at, at + PRINT_BYTES), print)) return true;
  }
  return false;
}

/// Whether a store isn't there for `me`: one they blocked (`mine`, their
/// own list), or one whose listing names them among those it blocked.
export async function storeHidden(catalog: MerchantCatalog, catalogRef: Uint8Array, me: Uint8Array, mine: Party[]): Promise<boolean> {
  if (mine.some((party) => "Store" in party && bytesEqual(party.Store, catalogRef))) return true;
  return listsKey(catalog.blocked ?? new Uint8Array(), catalog.block_salt ?? new Uint8Array(), me);
}

/// Whether `mine` names this person.
export const blocksPerson = (mine: Party[], person: Uint8Array) => mine.some((party) => "Person" in party && bytesEqual(party.Person, person));
