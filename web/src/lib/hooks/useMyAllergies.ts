import { bytesToHex } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { myAllergies } from "../../holochain/zomes/profiles";
import type { AllergySet } from "../../holochain/types";
import { NO_ALLERGIES } from "../storefront/allergens";
import { useResource } from "./useResource";

/// The signed-in account's allergies, opened on this device.
export function useMyAllergies(): { mine: AllergySet; loaded: boolean; reload: () => Promise<void> } {
  const { data, reload } = useResource(`my-allergies:${bytesToHex(myAgentPubKey())}`, myAllergies);
  return { mine: data ?? NO_ALLERGIES, loaded: data !== undefined, reload };
}
