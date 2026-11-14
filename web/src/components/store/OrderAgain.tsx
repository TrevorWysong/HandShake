// "Order again" on the home screen: the stores the customer last ordered
// from, newest first, one tap from each -- most orders are repeats. A store
// blocked either way isn't shown, as it isn't anywhere else.
import { Link } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import { getMyOrderHistory } from "../../holochain/zomes/dispatch";
import { getCatalog } from "../../holochain/zomes/catalog";
import { bytesToHex, decodeEntry } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import type { MerchantCatalog } from "../../holochain/types";
import { useResource } from "../../lib/hooks/useResource";
import { storesOrderedFrom } from "../../lib/orders/orderAgain";
import { toOrderRow } from "../../lib/orders/orderEntries";
import { myBlockList } from "../../lib/reputation/myBlockList";
import { storeHidden } from "../../lib/reputation/blockPrints";
import { useT } from "../../i18n";
import { SectionLabel } from "../ui";
import { StoreArt } from "./StoreArt";

interface Store {
  hex: string;
  catalog: MerchantCatalog;
}

async function storesToOrderAgain(): Promise<Store[]> {
  const page = await getMyOrderHistory(null);
  const refs = storesOrderedFrom(page.orders.map(toOrderRow));
  if (refs.length === 0) return [];
  const me = myAgentPubKey();
  const mine = await myBlockList({ Person: me });
  const stores = await Promise.all(
    refs.map(async (hash) => {
      const catalog = decodeEntry<MerchantCatalog>(await getCatalog(hash));
      return (await storeHidden(catalog, hash, me, mine)) ? null : { hex: bytesToHex(hash), catalog };
    }),
  );
  return stores.filter((store): store is Store => store !== null);
}

export function OrderAgain() {
  const t = useT();
  // Read once a visit: the list only changes when an order finishes.
  const { data: stores } = useResource("order-again", storesToOrderAgain);
  if (!stores?.length) return null;
  return (
    <section className="mb-5" aria-labelledby="order-again">
      <SectionLabel id="order-again" icon={<RotateCcw size={13} className="text-handshake-500" />} className="mb-2">
        {t("browse.orderAgain")}
      </SectionLabel>
      <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
        {stores.map(({ hex, catalog }) => (
          <Link key={hex} to={`/customer/merchant/${hex}`} className="w-32 shrink-0 overflow-hidden rounded-2xl border border-ink-100 bg-white transition active:scale-[0.98] dark:border-ink-800 dark:bg-ink-900">
            {catalog.banner_data_uri ? <img src={catalog.banner_data_uri} alt="" className="h-16 w-full object-cover" /> : <StoreArt storeHex={hex} cuisine={catalog.cuisine_type} className="h-16 text-2xl" />}
            <p className="truncate px-2.5 py-2 text-xs font-semibold text-ink-900 dark:text-ink-50">{catalog.business_name}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
