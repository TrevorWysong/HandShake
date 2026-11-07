// What's waiting on a store's answer beyond its kitchen queue -- reports of
// missing or wrong items, and appeals of its decisions -- read once for the
// whole app: the Issues tab, and the alert in the navigation (`MerchantNav` polls).
import { create } from "zustand";
import { getAppealsAgainstMe, getOrdersAwaitingAnswer } from "../holochain/zomes/dispatch";
import type { AppealView } from "../holochain/types";
import type { QueueRow } from "./merchantQueue";
import { storesKey, toRow } from "./merchantQueue";
import type { StoreRow } from "./merchantStores";

/// An order in the queue whose customer is waiting on the store's answer: they
/// can't get it, or say it never came. It belongs under Issues, not the kitchen's.
export const isDisputed = (row: QueueRow) => row.order.status === "Disputed";

interface MerchantIssuesState {
  /// Whose these are: a read for stores no longer shown is ignored.
  key: string | null;
  reports: QueueRow[] | undefined;
  appeals: AppealView[];
  refresh: (stores: StoreRow[], withAppeals: boolean) => Promise<void>;
}

export const useMerchantIssues = create<MerchantIssuesState>((set) => ({
  key: null,
  reports: undefined,
  appeals: [],
  refresh: async (stores, withAppeals) => {
    const [perStore, appeals] = await Promise.all([
      Promise.all(stores.map(async (store) => (await getOrdersAwaitingAnswer(store.hash)).map((entry) => toRow(entry, store.hex)))),
      withAppeals ? getAppealsAgainstMe() : null,
    ]);
    set({
      key: storesKey(stores),
      reports: perStore.flat().sort((a, b) => a.writtenAt - b.writtenAt),
      // The newest page: an appeal waits on its store only for a while.
      appeals: (appeals?.appeals ?? []).filter((appeal) => !appeal.answered && !appeal.ruling),
    });
  },
}));
