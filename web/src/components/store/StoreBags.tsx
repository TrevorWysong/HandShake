import { motion } from "framer-motion";
import { Check, PackageOpen, Plus } from "lucide-react";
import { bytesEqual, bytesToHex } from "../../holochain/decode";
import { bagStandings } from "../../holochain/zomes/dispatch";
import { useCart } from "../../store/cart";
import type { BagRow } from "../../lib/storefront/bags";
import { formatCents, formatClockTime } from "../../lib/ui/format";
import { fadeSlideUp } from "../../lib/ui/motion";
import { useResource } from "../../lib/hooks/useResource";
import { Button, SectionLabel, StatNumber } from "../ui";
import { useT } from "../../i18n";

/// A store's goodie bags -- end-of-day surplus at a discount -- each added
/// to the cart like an item, and had however the rest of the order is, if
/// the bag allows it (checkout says when it doesn't). How many are left,
/// and whether the customer has one already, come from the network.
export function StoreBags({ bags, onAdd }: { bags: BagRow[]; onAdd: (row: BagRow) => void }) {
  const t = useT();
  const lines = useCart((s) => s.lines);
  const refs = bags.map((row) => row.hash);
  const { data: standings } = useResource(bags.length > 0 ? `bag-standings:${refs.map(bytesToHex).join(",")}` : null, () => bagStandings(refs));

  if (bags.length === 0) return null;
  return (
    <motion.div variants={fadeSlideUp} className="mt-6">
      <SectionLabel icon={<PackageOpen size={13} className="text-handshake-500" />} className="mb-2">
        {t("store.bags")}
      </SectionLabel>
      <div className="grid gap-2 md:grid-cols-2">
        {bags.map((row, i) => {
          const { bag } = row;
          const standing = standings?.[i];
          const inCart = lines.some((line) => line.bag && bytesEqual(line.itemRef, row.hash));
          const only = bag.supports_pickup && bag.supports_delivery ? null : bag.supports_pickup ? t("cart.bag.pickupOnly") : t("cart.bag.deliveryOnly");
          const unavailable = standing?.ordered ? t("store.bag.ordered") : standing?.left === 0 ? t("store.bag.soldOut") : null;
          return (
            <div key={bytesToHex(row.hash)} className="flex items-center gap-3 rounded-2xl border border-ink-100 bg-white p-4 dark:border-ink-800 dark:bg-ink-900">
              {bag.photo_data_uri ? (
                <img src={bag.photo_data_uri} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
              ) : (
                <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-300 to-handshake-500 text-xl" aria-hidden>
                  🎁
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{bag.title}</p>
                {bag.description && <p className="truncate text-xs text-ink-400">{bag.description}</p>}
                <div className="flex items-center gap-2">
                  <StatNumber className="text-sm">{formatCents(bag.price_cents)}</StatNumber>
                  <span className="text-xs text-ink-400 line-through">{formatCents(bag.original_value_cents)}</span>
                </div>
                <p className="text-[11px] text-ink-400">
                  {t("store.bag.until", { time: formatClockTime(bag.pickup_window_end) })}
                  {standing && standing.left > 0 && ` · ${t("store.bag.left", { count: standing.left })}`}
                  {only && ` · ${only}`}
                </p>
              </div>
              {unavailable ? (
                <span className="shrink-0 rounded-full bg-ink-100 px-3 py-1.5 text-xs font-semibold text-ink-500 dark:bg-ink-800 dark:text-ink-400">{unavailable}</span>
              ) : inCart ? (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-presence-500/10 px-3 py-1.5 text-xs font-semibold text-presence-600 dark:text-presence-400">
                  <Check size={13} /> {t("store.bag.inCart")}
                </span>
              ) : (
                <Button className="shrink-0 px-3 py-1.5 text-xs" disabled={!standing} onClick={() => onAdd(row)}>
                  <Plus size={13} /> {t("store.bag.add")}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
