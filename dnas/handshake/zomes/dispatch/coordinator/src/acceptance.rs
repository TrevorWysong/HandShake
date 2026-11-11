//! What a store checks of a customer before accepting their order, beyond
//! its menu and terms -- what only the store can know, and only the store
//! loses by: that the customer's points cover the reward the order spends
//! (points are private between the two, worked out from the store's own
//! records), that a newcomers' code goes to a real newcomer (a card an
//! issuer vouched for), and that the customer isn't flooding its queue with
//! orders they call off before it can answer. Each reads what the store
//! holds or can look up without its customer online.

use dispatch_integrity::*;
use handshake_coordinator_support::{call_local, guest};
use hdk::prelude::*;

/// Whether the order spends a reward the customer's points at the store
/// don't cover (the rewards zome's `can_redeem`).
///
/// Validation can't see points, so nothing re-checks this at commit. Two
/// acceptances at once can't both spend the same points only because the
/// store's chain is written in strict order (the HDK's default): the second
/// to commit finds the chain moved under it and fails, and tried again, it
/// counts the first's spend. Accepting must never write with
/// `ChainTopOrdering::Relaxed` (tests/tryorama/src/rewards-concurrency.test.ts).
pub(crate) fn reward_unavailable(requester: &AgentPubKey, catalog_ref: &ActionHash, rewards: Option<&OrderRewards>) -> ExternResult<bool> {
    let Some(rewards) = rewards else { return Ok(false) };
    let Some(reward) = rewards.reward else { return Ok(false) };
    #[derive(Serialize, Debug)]
    struct RedeemCheck<'a> {
        customer: &'a AgentPubKey,
        catalog_ref: &'a ActionHash,
        program: &'a ActionHash,
        reward: u16,
    }
    Ok(call_local::<_, ()>("rewards", "can_redeem", RedeemCheck { customer: requester, catalog_ref, program: &rewards.program, reward })?.is_err())
}

/// How many orders a customer may call off at one store, before it answers
/// them, in `CANCEL_WINDOW` -- past that, its next ones are declined.
pub(crate) const MAX_EARLY_CANCELS: usize = 3;
const CANCEL_WINDOW_MICROS: i64 = 24 * 3_600_000_000;

/// Whether `requester` has called off `MAX_EARLY_CANCELS` orders at
/// `catalog_ref` lately without paying for them: before the store answered,
/// or before they saw it start (the stale-branch race, which a modified app
/// could otherwise play every time). Read from the store's own queues --
/// every order the customer put there in the window, however many others
/// the store took meanwhile -- so it needs nothing from the customer.
pub(crate) fn serial_canceller(requester: &AgentPubKey, catalog_ref: &ActionHash) -> ExternResult<bool> {
    let since = Timestamp::from_micros(sys_time()?.as_micros() - CANCEL_WINDOW_MICROS);
    let mut free = 0;
    for order in crate::order_queues::orders_queued_by(catalog_ref, requester, since)? {
        if !crate::confirmations::cancelled_in_time(order)? {
            continue;
        }
        free += 1;
        if free >= MAX_EARLY_CANCELS {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Why the store won't accept this order, of these, if one applies.
pub(crate) fn decline_for(requester: &AgentPubKey, catalog_ref: &ActionHash, rewards: Option<&OrderRewards>) -> ExternResult<Option<DeclineReason>> {
    Ok(if serial_canceller(requester, catalog_ref)? {
        Some(DeclineReason::TooManyCancellations)
    } else if reward_unavailable(requester, catalog_ref, rewards)? {
        Some(DeclineReason::RewardUnavailable)
    } else {
        None
    })
}

/// Refuses to accept an order `decline_for` would decline, saying why.
pub(crate) fn ensure_acceptable(requester: &AgentPubKey, catalog_ref: &ActionHash, rewards: Option<&OrderRewards>) -> ExternResult<()> {
    match decline_for(requester, catalog_ref, rewards)? {
        None => Ok(()),
        Some(DeclineReason::TooManyCancellations) => Err(guest("This customer has called off several orders here lately before you could answer, so this one can't be accepted -- decline it.")),
        Some(_) => Err(guest("This customer's points don't cover the reward this order spends, so it can't be accepted -- decline it.")),
    }
}

/// Records, privately, an order the store just accepted that joined its
/// rewards program -- what its members' points are worked out from.
pub(crate) fn record_member_order(order: &ActionHash, accepted: &ActionHash, rewards: Option<&OrderRewards>) -> ExternResult<()> {
    if rewards.is_none() {
        return Ok(());
    }
    #[derive(Serialize, Debug)]
    struct MemberOrderInput<'a> {
        order: &'a ActionHash,
        accepted: &'a ActionHash,
    }
    call_local::<_, ()>("rewards", "record_member_order", MemberOrderInput { order, accepted })?.map_err(|e| guest(format!("recording the order for rewards: {e}")))
}
