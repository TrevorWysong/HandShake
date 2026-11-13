import { callZome } from "../client";
import type { ActionHash, AgentPubKey, CustomerReason, CustomerScore, Finding, FindingView, HcRecord, MyCustomerRating, Party, RatingSummary, ReputationSummary, ReputationTarget, ReviewTarget, Timestamp } from "../types";

/// A UI-display cache only -- see `reputation_integrity`'s doc comment.
/// Never the actual trust decision on its own; `check_warrants`
/// (dispatch.ts) is the real signal `accept_bid` gates on.
export async function getReputationSummary(target: ReputationTarget): Promise<ReputationSummary> {
  return callZome("reputation", "get_reputation_summary", target);
}

/// Refused if the caller already rated this target on this order -- one
/// rating per store/driver per order.
export async function submitReview(input: { target: ReviewTarget; order_original_action: ActionHash; rating: number; comment: string }): Promise<HcRecord> {
  return callZome("reputation", "submit_review", input);
}

export interface ReviewsPage {
  reviews: HcRecord[];
  next_before: Timestamp | null;
}

/// Newest first, paginated -- pass the previous page's `next_before` to load
/// older reviews. For the average, use `getRatingSummary` instead of
/// loading every review.
export async function getReviewsFor(target: ReviewTarget, before: Timestamp | null = null): Promise<ReviewsPage> {
  return callZome("reputation", "get_reviews_for", { target, before });
}

/// The star rating for a store or driver, as a running count + sum
/// (checkpointed on the Rust side, so it stays cheap as reviews pile up).
export async function getRatingSummary(target: ReviewTarget): Promise<RatingSummary> {
  return callZome("reputation", "get_rating_summary", target);
}

/// The caller's own store/driver reviews already left on this order -- an
/// order screen uses this to show "thanks for rating" instead of the form.
export async function getMyReviewsForOrder(orderOriginalAction: ActionHash): Promise<HcRecord[]> {
  return callZome("reputation", "get_my_reviews_for_order", orderOriginalAction);
}

/// `null` when there are no ratings yet.
export function averageRating(summary: RatingSummary): number | null {
  return summary.count > 0 ? summary.rating_sum / summary.count : null;
}

// --- per-item ratings -- same shape as the store/driver reviews above,
// keyed by a MenuItem's action hash instead ---

export async function submitItemReview(input: { item_ref: ActionHash; order_original_action: ActionHash; rating: number; comment: string }): Promise<HcRecord> {
  return callZome("reputation", "submit_item_review", input);
}

export interface ItemRatingSummary {
  count: number;
  rating_sum: number;
}

/// The most items one `getItemRatingSummaries` call reads (`ITEM_BATCH`).
export const ITEM_BATCH = 100;

/// Each item's rating, in order -- read together, a batch at a time.
export async function getItemRatingSummaries(itemRefs: ActionHash[]): Promise<ItemRatingSummary[]> {
  const batches: ActionHash[][] = [];
  for (let i = 0; i < itemRefs.length; i += ITEM_BATCH) batches.push(itemRefs.slice(i, i + ITEM_BATCH));
  const read = await Promise.all(batches.map((batch) => callZome<ItemRatingSummary[]>("reputation", "get_item_rating_summaries", batch)));
  return read.flat();
}

/// A menu item's reviews, newest first -- pass the previous page's
/// `next_before` to continue.
export async function getItemReviews(itemRef: ActionHash, before: Timestamp | null = null): Promise<ReviewsPage> {
  return callZome("reputation", "get_item_reviews", { item_ref: itemRef, before });
}

/// The caller's store recording its finding on a report it's answered: that
/// it wasn't made in good faith, or that the driver was at fault
/// (docs/REPUTATION.md) -- a call of its own, after the answer.
export async function recordFinding(input: { order: ActionHash; issue: ActionHash; finding: Finding }): Promise<HcRecord> {
  return callZome("reputation", "record_finding", input);
}

/// The caller's one public reply to a store's finding about them.
export async function replyToFinding(input: { event: ActionHash; text: string }): Promise<HcRecord> {
  return callZome("reputation", "reply_to_finding", input);
}

/// Every store's finding about a customer or driver, newest first, with
/// their replies.
export async function getFindings(target: ReputationTarget): Promise<FindingView[]> {
  return callZome("reputation", "get_findings", target);
}

/// The caller -- an order's store or its driver -- rating its customer, once.
export async function rateCustomer(input: { order: ActionHash; up: boolean; reason: CustomerReason | null }): Promise<HcRecord> {
  return callZome("reputation", "rate_customer", input);
}

/// The caller's rating of an order's customer, if they've given one.
export async function myCustomerRating(order: ActionHash): Promise<MyCustomerRating | null> {
  return callZome("reputation", "my_customer_rating", order);
}

/// A customer's score: the share of thumbs-up over their recent rated orders.
export async function getCustomerScore(customer: AgentPubKey): Promise<CustomerScore> {
  return callZome("reputation", "get_customer_score", customer);
}

/// The caller blocking a party, as themselves or as their store.
export async function block(by: Party, blocked: Party): Promise<void> {
  return callZome("reputation", "block", { by, blocked });
}

/// The caller lifting a block they made.
export async function unblock(by: Party, blocked: Party): Promise<void> {
  return callZome("reputation", "unblock", { by, blocked });
}

/// Whom the caller has blocked, as themselves or as a store of theirs.
export async function myBlocks(by: Party): Promise<Party[]> {
  return callZome("reputation", "my_blocks", by);
}

/// Whether each pair is blocked, either way -- read together.
export async function blockedPairs(pairs: [Party, Party][]): Promise<boolean[]> {
  return pairs.length === 0 ? [] : callZome("reputation", "blocked_pairs", pairs);
}
