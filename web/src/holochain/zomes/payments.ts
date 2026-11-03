// Paying for orders directly (dispatch's `payments`): a payer's app offers
// a card to the payee of one leg of an order; the payee's payment agent
// holds it on its own processor, asks for more, or declines it -- and later
// captures exactly what it's owed. Amounts are always the network's.
import { callZome } from "../client";
import type { ActionHash, AgentPubKey, OrderPayment, PaymentHistoryItem, PaymentInput, PaymentLeg, PaymentProfile, PaymentStanding } from "../types";

/// Offers a card for `leg` of `order`: a single-use token from the payee's
/// processor's card form (or `null` for the card saved with them), sealed to
/// the payee. `resumes`: the `PaymentAction` this answers, once done.
export async function offerPayment(order: ActionHash, leg: PaymentLeg, payment: PaymentInput, resumes: ActionHash | null = null): Promise<ActionHash> {
  return callZome("dispatch", "offer_payment", { order, leg, payment, resumes });
}

/// Where the caller's payment for a leg of an order stands -- `null` before
/// they've offered one.
export async function myPayment(order: ActionHash, leg: PaymentLeg): Promise<PaymentStanding | null> {
  return callZome("dispatch", "my_payment", { order, leg });
}

/// The payee's hold of a leg of an order, once made (`null` too for a leg
/// that needs nothing).
export async function paymentHold(order: ActionHash, leg: PaymentLeg): Promise<ActionHash | null> {
  return callZome("dispatch", "payment_hold", { order, leg });
}

/// Every payment held on an order: who paid whom, what was held, and what
/// was charged once settled.
export async function orderPayments(order: ActionHash): Promise<OrderPayment[]> {
  return callZome("dispatch", "order_payments", order);
}

/// How `agent` is paid -- their processor and its public card-form details
/// -- or `null` if they can't take card payments.
export async function paymentProfileOf(agent: AgentPubKey): Promise<PaymentProfile | null> {
  return callZome("dispatch", "payment_profile_of", agent);
}

/// Every payment the caller made or received in the last `days`, newest
/// first, each charged part broken out once settled.
export async function myPaymentHistory(days: number): Promise<PaymentHistoryItem[]> {
  return callZome("dispatch", "my_payment_history", days);
}
