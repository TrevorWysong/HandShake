// What the store side's per-store pages share: the store being worked on
// (`StoreSwitcher`/`merchantStores.ts`), keyed by it, so switching stores
// mounts a fresh page -- nothing from one store can linger on another. Its
// data is `useStore`'s.
import { Fragment, type ReactNode } from "react";
import { useMerchantStores, useMyStores } from "../../store/merchantStores";
import { Skeleton } from "../../components/ui";
import { StoreSwitcher } from "../../components/store/StoreSwitcher";
import { NewStoreForm } from "./NewStore";

/// The active store's page, `children(storeHex)` -- or, before there's a
/// store, the form that sets up the first one.
export function ForActiveStore({ children }: { children: (storeHex: string) => ReactNode }) {
  const stores = useMyStores();
  const activeHex = useMerchantStores((s) => s.activeHex);
  if (stores !== null && stores.length === 0) return <NewStoreForm firstStore />;
  if (stores === null || !activeHex) return <StoreSkeleton />;
  return <Fragment key={activeHex}>{children(activeHex)}</Fragment>;
}

export function StoreSkeleton() {
  return (
    <div className="px-4 pt-4">
      <StoreSwitcher />
      <Skeleton className="mb-4 h-32 w-full" />
      <Skeleton className="mb-3 h-6 w-1/2" />
      <Skeleton className="mb-3 h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
