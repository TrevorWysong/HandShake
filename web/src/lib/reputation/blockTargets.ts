// Who's there to block on an order, as each side sees it -- read when the
// "…" sheet opens (`BlockActions`).
import { listBidsForOrder } from "../../holochain/zomes/dispatch";
import { getCatalog } from "../../holochain/zomes/catalog";
import { getProfileForAgent } from "../../holochain/zomes/profiles";
import { actionHash, bytesToHex, decodeEntry } from "../../holochain/decode";
import type { ActionHash, AgentPubKey, Bid, MerchantCatalog, Profile } from "../../holochain/types";
import { shortAgentId } from "../ui/format";

/// A person's name as others see it, or their short id.
export async function personName(agent: AgentPubKey): Promise<string> {
  const record = await getProfileForAgent(agent).catch(() => null);
  return (record && decodeEntry<Profile>(record).display_name) || shortAgentId(agent);
}

/// A store's name.
export async function storeName(catalogRef: ActionHash): Promise<string> {
  return decodeEntry<MerchantCatalog>(await getCatalog(catalogRef)).business_name;
}

/// The driver an order's accepted bid names, if it has one.
export async function driverOf(order: ActionHash, acceptedBid: ActionHash | null): Promise<AgentPubKey | null> {
  if (!acceptedBid) return null;
  const hex = bytesToHex(acceptedBid);
  const won = (await listBidsForOrder(order)).bids.find((record) => bytesToHex(actionHash(record)) === hex);
  return won ? decodeEntry<Bid>(won).bidder : null;
}
