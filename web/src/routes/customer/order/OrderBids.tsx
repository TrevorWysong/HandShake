// The bids on a customer's open order -- each with its bidder's record,
// load and complaints, ranked as the network's matching rule ranks them --
// so accepting one is an informed choice, not just price and ETA.
import { AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { listBidsForOrder, checkWarrants, getDriverLoad, rankBids } from "../../../holochain/zomes/dispatch";
import { fetchDriverStats, type DriverStats } from "../../../lib/driving/driverStats";
import { decodeEntry, actionHash, bytesEqual, bytesToHex, timestampOf } from "../../../holochain/decode";
import { Button, Card, Skeleton } from "../../../components/ui";
import { StarRating } from "../../../components/StarRating";
import { formatCents, formatEta, shortAgentId, formatClockTime } from "../../../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../../../lib/ui/motion";
import { useResource } from "../../../lib/hooks/useResource";
import type { ActionHash, Bid, DeliveryOrder, InHand, WarrantSummary } from "../../../holochain/types";
import { carryRefusal, customerRefusal, describeLoad } from "../../../lib/driving/driverLoad";
import { useTerms } from "../../../store/network";
import { POLL, isOrderOrBidSignal } from "../../../lib/network/poll";
import { useT } from "../../../i18n";
import { BidWeightBreakdown, HowBidsCompare } from "../../../components/orders/BidWeights";

/// A bid's bidder, with their warrant count and driver track record.
interface BidRow {
  hash: Uint8Array;
  bid: Bid;
  /// When it was placed (microseconds).
  placedAt: number;
  warrants: WarrantSummary | null;
  stats: DriverStats | null;
  /// The orders the driver has taken on, if it could be read.
  load: InHand | null;
}

/// The open order's bids, best match first -- shown while it's open. Accepting one is the order
/// page's step (`onAccept`), so it can't run alongside its others;
/// `accepting` is the one running, as `bid:<hex>`.
export function OrderBids({ orderRef, order, accepting, onAccept }: { orderRef: ActionHash; order: DeliveryOrder; accepting: string | null; onAccept: (bid: Uint8Array, overrideWarrants: boolean) => void }) {
  const t = useT();
  const terms = useTerms();
  const hash = bytesToHex(orderRef);
  // Each bid with its bidder's track record (shown while the order is open).
  const { data: bids = null } = useResource(
    `order-bids:${hash}`,
    async (): Promise<BidRow[]> => {
      const page = await listBidsForOrder(orderRef);
      return Promise.all(
        page.bids.map(async (record) => {
          const bid = decodeEntry<Bid>(record);
          const [warrants, stats, load] = await Promise.all([
            checkWarrants(bid.bidder).catch(() => null),
            fetchDriverStats(bid.bidder).catch(() => null),
            getDriverLoad(bid.bidder).catch(() => null),
          ]);
          return { hash: actionHash(record), bid, placedAt: timestampOf(record), warrants, stats, load };
        }),
      );
    },
    { pollMs: POLL.signalled, refreshOn: isOrderOrBidSignal },
  );
  // The bids as the network's matching rule ranks them -- what an order set
  // to match automatically accepts once the bid window has run.
  const { data: ranking = [] } = useResource(`order-ranking:${hash}:${bids?.length ?? 0}`, () => rankBids(orderRef));
  const rankOf = new Map(ranking.map((r, i) => [bytesToHex(r.bid), i]));
  const weightOf = new Map(ranking.map((r) => [bytesToHex(r.bid), r.weight]));
  const nameOf = (row: BidRow) => row.stats?.displayName || t("order.driverNamed", { id: shortAgentId(row.bid.bidder) });
  const bestMatch = ranking.find((r) => r.unavailable === null);
  const rankedBids = bids && [...bids].sort((a, b) => (rankOf.get(bytesToHex(a.hash)) ?? Infinity) - (rankOf.get(bytesToHex(b.hash)) ?? Infinity));
  const firstBidAt = bids && bids.length > 0 ? Math.min(...bids.map((b) => b.placedAt)) : null;

  return (
    <motion.div variants={fadeSlideUp} className="mt-5">
      <div className="mb-2 flex items-center gap-1">
        <h2 className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("order.bids")}</h2>
        {/* How they're compared, with each bid's working. */}
        <HowBidsCompare>
          {rankedBids?.map((row) => {
            const weight = weightOf.get(bytesToHex(row.hash));
            return (
              weight && (
                <section key={bytesToHex(row.hash)} className="rounded-2xl bg-ink-50 p-4 dark:bg-ink-800/60">
                  <p className="mb-2 text-sm font-semibold text-ink-900 dark:text-ink-50">{nameOf(row)}</p>
                  <BidWeightBreakdown fee={row.bid.price_offer} weight={weight} />
                </section>
              )
            );
          })}
        </HowBidsCompare>
      </div>
      {bids === null && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i} className="p-3.5">
              <Skeleton className="h-4 w-1/2 mb-2" />
              <Skeleton className="h-3 w-1/3" />
            </Card>
          ))}
        </div>
      )}
      {bids?.length === 0 && <p className="text-xs text-ink-400">{t("order.waitingBids")}</p>}
      {order.auto_match && firstBidAt !== null && (
        <p className="mb-2 text-xs leading-relaxed text-ink-500">
          {t("order.autoMatchAt", { time: formatClockTime(firstBidAt + terms.bid_window_secs * 1_000_000), minuteValue: formatCents(terms.minute_value_cents) })}
        </p>
      )}
      <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {rankedBids?.map((row) => {
            const { hash: bidHash, bid, warrants: w, stats, load } = row;
            const weight = weightOf.get(bytesToHex(bidHash));
            const complaints = w !== null && w.count > 0;
            const refusal = load && carryRefusal(load, order.priority, terms.max_concurrent_deliveries);
            return (
              <motion.div key={bytesToHex(bidHash)} layout variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0, scale: 0.97 }}>
                <Card className="flex items-center justify-between p-3.5">
                  <div>
                    <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">
                      {nameOf(row)} · {formatEta(bid.eta_seconds)}
                      {bestMatch && bytesEqual(bestMatch.bid, bidHash) && <span className="ml-2 rounded-full bg-handshake-100 px-2 py-0.5 text-[10px] font-bold text-handshake-700 dark:bg-handshake-900/30 dark:text-handshake-300">{t("order.bestMatch")}</span>}
                    </p>
                    <p className="text-xs text-ink-400">
                      {t("order.bidFee", { amount: formatCents(bid.price_offer) })}
                      {weight && <span> · {t("bidWeight.countsAsShort", { amount: formatCents(weight.cost) })}</span>}
                    </p>
                    {stats && (
                      <div className="mt-1 flex items-center gap-1.5">
                        {stats.reviewCount > 0 ? (
                          <StarRating value={stats.avgRating} count={stats.reviewCount} size={11} />
                        ) : (
                          <span className="text-xs text-ink-400">{t("order.noReviews")}</span>
                        )}
                        <span className="text-xs text-ink-400">· {t("order.completed", { count: stats.completedCount })}</span>
                        {stats.droppedCount > 0 && <span className="text-xs text-amber-600 dark:text-amber-400">· {t("order.dropped", { count: stats.droppedCount })}</span>}
                        {stats.lapsedCount > 0 && <span className="text-xs text-ink-400">· {t("order.lapsed", { count: stats.lapsedCount })}</span>}
                      </div>
                    )}
                    {load && <p className="mt-1 text-xs text-ink-400">{describeLoad(load)}</p>}
                    {complaints && (
                      <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-400">
                        <AlertTriangle size={12} /> {t("order.complaints", { count: w.count })}
                      </p>
                    )}
                  </div>
                  {refusal ? (
                    <span className="max-w-[7.5rem] text-right text-[11px] font-medium leading-tight text-ink-400">{customerRefusal(refusal)}</span>
                  ) : (
                    <Button
                      variant={complaints ? "danger" : "primary"}
                      className="px-4 py-2 text-xs"
                      loading={accepting === `bid:${bytesToHex(bidHash)}`}
                      onClick={() => onAccept(bidHash, complaints)}
                    >
                      {complaints ? t("order.acceptAnyway") : t("order.accept")}
                    </Button>
                  )}
                </Card>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
