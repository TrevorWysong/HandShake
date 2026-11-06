import { getRatingSummary, getReputationSummary } from "../../holochain/zomes/reputation";
import { useResource } from "./useResource";

/// A store's rating, keyed by the store and not its owner, so a multi-store
/// owner's other locations (or their driving) never bleed in; and how it
/// treats drivers: times it kept one waiting (each refunded its customer),
/// and drivers' reports it wouldn't check them in.
export function useStoreStanding(hash: string, catalogHash: Uint8Array) {
  const { data: rating } = useResource(`store-rating:${hash}`, () => getRatingSummary({ Store: catalogHash }));
  const { data: record = null } = useResource(`store-record:${hash}`, () => getReputationSummary({ Store: catalogHash }));
  return { rating, record };
}
