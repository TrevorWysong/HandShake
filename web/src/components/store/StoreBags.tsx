import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PackageOpen } from "lucide-react";
import { claimGoodieBag, type FulfillmentInput } from "../../holochain/zomes/catalog";
import { bytesToHex } from "../../holochain/decode";
import type { GeoPoint, GoodieBag } from "../../holochain/types";
import { useSession } from "../../store/session";
import { currencySymbol, formatCents, toMinorUnits } from "../../lib/ui/format";
import { fadeSlideUp } from "../../lib/ui/motion";
import { useAction } from "../../lib/hooks/useAction";
import { AddressSearch } from "../places/AddressSearch";
import { Button, Input, SectionLabel, StatNumber } from "../ui";
import { useT } from "../../i18n";

export interface BagRow {
  hash: Uint8Array;
  bag: GoodieBag;
}

/// A store's goodie bags -- end-of-day surplus at a discount -- each
/// claimed for pickup or delivery from its own card.
export function StoreBags({ bags }: { bags: BagRow[] }) {
  const t = useT();
  const location = useSession((s) => s.location);
  const [claimingBagHex, setClaimingBagHex] = useState<string | null>(null);
  const [claimFulfillment, setClaimFulfillment] = useState<"Pickup" | "Delivery">("Pickup");
  const [claimDropoff, setClaimDropoff] = useState<GeoPoint>(location);
  const [claimFee, setClaimFee] = useState(5);
  const action = useAction();
  const [claimedBagHexes, setClaimedBagHexes] = useState<Set<string>>(new Set());

  function openClaim(row: BagRow) {
    const hex = bytesToHex(row.hash);
    setClaimingBagHex(claimingBagHex === hex ? null : hex);
    setClaimFulfillment(row.bag.supports_pickup ? "Pickup" : "Delivery");
    setClaimDropoff(location);
    setClaimFee(5);
    action.setError(null);
  }

  const submitClaim = (row: BagRow) => action.run(async () => {
    const fulfillment: FulfillmentInput =
      claimFulfillment === "Pickup" ? "Pickup" : { Delivery: { dropoff: claimDropoff, max_delivery_fee: toMinorUnits(claimFee) } };
    await claimGoodieBag(row.hash, fulfillment);
    setClaimedBagHexes((prev) => new Set(prev).add(bytesToHex(row.hash)));
    setClaimingBagHex(null);
  });

  if (bags.length === 0) return null;
  return (
      <motion.div variants={fadeSlideUp} className="mt-6">
        <SectionLabel icon={<PackageOpen size={13} className="text-handshake-500" />} className="mb-2">{t("store.bags")}</SectionLabel>
        <div className="flex flex-col gap-2">
          {bags.map((row) => {
            const hex = bytesToHex(row.hash);
            const claimed = claimedBagHexes.has(hex);
            const open = claimingBagHex === hex;
            return (
              <div key={hex} className="rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
                <div className="flex items-center gap-3">
                  {row.bag.photo_data_uri ? (
                    <img src={row.bag.photo_data_uri} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
                  ) : (
                    <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-300 to-handshake-500 text-xl">🎁</div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{row.bag.title}</p>
                    {row.bag.description && <p className="truncate text-xs text-ink-400">{row.bag.description}</p>}
                    <div className="flex items-center gap-2">
                      <StatNumber className="text-sm">{formatCents(row.bag.price_cents)}</StatNumber>
                      <span className="text-xs text-ink-400 line-through">{formatCents(row.bag.original_value_cents)}</span>
                    </div>
                  </div>
                  <Button
                    variant={claimed ? "secondary" : "primary"}
                    disabled={claimed}
                    className="shrink-0 px-3 py-1.5 text-xs"
                    onClick={() => openClaim(row)}
                  >
                    {claimed ? t("store.claimed") : open ? t("common.cancel") : t("store.claim")}
                  </Button>
                </div>

                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                      <div className="mt-3 flex flex-col gap-2 border-t border-ink-100 dark:border-ink-800 pt-3">
                        {row.bag.supports_pickup && row.bag.supports_delivery && (
                          <div className="flex gap-2">
                            {(["Pickup", "Delivery"] as const).map((f) => (
                              <button
                                key={f}
                                onClick={() => setClaimFulfillment(f)}
                                className={`flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                                  claimFulfillment === f ? "bg-handshake-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"
                                }`}
                              >
                                {t(f === "Pickup" ? "cart.pickup" : "cart.delivery")}
                              </button>
                            ))}
                          </div>
                        )}
                        {claimFulfillment === "Delivery" && (
                          <>
                            <AddressSearch value={claimDropoff} onChange={setClaimDropoff} label={t("store.deliveryLocation")} />
                            <Input type="number" min={0} step={0.5} value={claimFee} onChange={(e) => setClaimFee(Number(e.target.value))} placeholder={t("store.maxFee")} prefix={currencySymbol()} />
                          </>
                        )}
                        {action.error && <p className="text-xs text-red-500">{action.error}</p>}
                        <Button loading={action.busy} onClick={() => submitClaim(row)} className="py-2 text-xs">
                          {t("store.confirmClaim")}
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </motion.div>);
}
