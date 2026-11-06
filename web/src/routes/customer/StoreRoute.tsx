// What a storefront's two pages share: the store named in the URL.
import type { ReactNode } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { storeSuccessor } from "../../holochain/zomes/catalog";
import { bytesToHex, hexToBytes } from "../../holochain/decode";
import { useResource } from "../../lib/hooks/useResource";

/// A store its owner moved to a new key (a new phone) sends customers on to
/// the same page of the new one -- a saved favourite, an old link.
export function StoreRoute({ children }: { children: (hash: string) => ReactNode }) {
  const { hash } = useParams<{ hash: string }>();
  const { pathname } = useLocation();
  const { data: movedTo } = useResource(hash ? `store-successor:${hash}` : null, () => storeSuccessor(hexToBytes(hash!)));
  if (!hash) return null;
  if (movedTo) return <Navigate to={pathname.replace(hash, bytesToHex(movedTo))} replace />;
  return children(hash);
}
