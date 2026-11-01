//! Chat and live driver location: what an order's two active parties tell
//! each other while it's under way -- a delivery's customer and its driver,
//! a pickup's customer and its store. Neither is ever written down -- a
//! chat line is lower-stakes than anything this app stores, and a GPS ping
//! every few seconds would grow a driver's chain without bound for data
//! nobody needs once the order's done. So no history survives a reload:
//! an honest, named limitation, not an oversight.
//!
//! Both travel as Holochain direct signals, app to app, with no zome code
//! on either end (the app's `holochain/live.ts`). The network vouches for
//! who sent one; what it can't know is whether the sender is on the order.
//! That's this extern: each end asks once who its counterpart is, then
//! checks every signal it sends or receives against the answer. Only a
//! delivery's driver shares a location, and only its customer hears one.
//!
//! Each device grants direct signals in `prepare_device` (signals.rs).

use crate::signals::OrderRole;
use dispatch_integrity::{Bid, DeliveryOrder, PickupOrder};
use hdk::prelude::*;
use handshake_coordinator_support::{decode_or, guest, resolve_latest, resolve_latest_decoded};

/// The other active party on an order, and which side each is on.
#[derive(Serialize, Deserialize, Debug)]
pub struct LiveCounterpart {
    pub counterpart: AgentPubKey,
    /// The caller's side: `Customer`, `Driver` or `Store`.
    pub role: OrderRole,
    /// The counterpart's side -- a location is heard only from a `Driver`.
    pub counterpart_role: OrderRole,
}

/// Who the caller talks to about `order_ref`: on a delivery, the driver
/// whose bid was accepted if they're its customer, its customer if they're
/// that driver (the store isn't on that channel); on a pickup, its store if
/// they're its customer, its customer if they're the store.
#[hdk_extern]
pub fn live_counterpart(order_ref: ActionHash) -> ExternResult<LiveCounterpart> {
    let me = agent_info()?.agent_initial_pubkey;
    let latest = resolve_latest(order_ref.clone())?;
    if let Some(order) = decode_or::<PickupOrder>(&latest) {
        return pair(&me, (order.requester, OrderRole::Customer), (order.merchant, OrderRole::Store)).ok_or(guest("Only this order's customer and its store can chat about it."));
    }
    let (_, order): (_, DeliveryOrder) = resolve_latest_decoded(order_ref, "DeliveryOrder")?;
    let bid_ref = order.accepted_bid.ok_or(guest("This order has no driver yet."))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(bid_ref, "Bid")?;
    pair(&me, (order.requester, OrderRole::Customer), (bid.bidder, OrderRole::Driver)).ok_or(guest("Only this order's customer and its driver can chat about it."))
}

/// The caller's counterpart between two parties, if they're one of them.
/// Someone on both sides -- a store owner ordering from themselves -- has
/// no one to talk to.
fn pair(me: &AgentPubKey, a: (AgentPubKey, OrderRole), b: (AgentPubKey, OrderRole)) -> Option<LiveCounterpart> {
    if a.0 == b.0 {
        return None;
    }
    let ((_, role), (counterpart, counterpart_role)) = if &a.0 == me { (a, b) } else if &b.0 == me { (b, a) } else { return None };
    Some(LiveCounterpart { counterpart, role, counterpart_role })
}
