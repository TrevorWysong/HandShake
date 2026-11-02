//! Goodie bags on an order. A bag is a line like any item, at its own
//! price, once per customer (validation's rules, `checks::bag_line_problem`).
//! What validation can't do is count how many of a bag are sold -- that's
//! a walk across other customers' orders. The store does it, as it accepts
//! an order: only the store can accept, so it can't be skipped, and it
//! reads the sales it recorded itself (`BagToOrder`, its own links), so
//! it's never behind. A sold-out bag's order is declined -- as is one whose
//! window closed before the order could have reached the store, by its own
//! clock (an order's timestamp is its customer's word) -- and an accepted
//! one is recorded as sold in the same commit as the acceptance.

use catalog_types::GoodieBag;
use dispatch_integrity::*;
use handshake_coordinator_support::{decode_or, guest, original_action_of};
use hdk::prelude::*;

/// The goodie bags on an order's lines, as listed: each bag's identity and
/// terms (as the line was priced; a bag's terms never change).
pub(crate) fn bags_on(lines: &[OrderLine]) -> ExternResult<Vec<(ActionHash, GoodieBag)>> {
    let mut bags = Vec::new();
    for line in lines {
        let Some(record) = get(line.priced_version.clone(), GetOptions::default())? else { continue };
        if let Some(bag) = decode_or::<GoodieBag>(&record) {
            bags.push((line.item_ref.clone(), bag));
        }
    }
    Ok(bags)
}

/// The orders the caller's store has recorded selling `bag` to.
fn sales_of(bag: &ActionHash, me: &AgentPubKey) -> ExternResult<Vec<Link>> {
    get_links(LinkQuery::try_new(bag.clone(), LinkTypes::BagToOrder)?.author(me.clone()), GetStrategy::Local)
}

/// The first goodie bag on `order` (its original action) the caller's store
/// can't sell it, by name: sold to other orders up to its quantity, or its
/// window closed longer ago than an order placed in it could take to
/// arrive (`store_response_window`), by the store's clock.
pub(crate) fn unavailable_bag(order: &ActionHash, lines: &[OrderLine]) -> ExternResult<Option<String>> {
    let me = agent_info()?.agent_initial_pubkey;
    let order: AnyLinkableHash = original_action_of(order.clone())?.into();
    let window = handshake_governance::store_response_window().as_micros() as i64;
    let now = sys_time()?.as_micros();
    for (bag_ref, bag) in bags_on(lines)? {
        let sold_to_others = sales_of(&bag_ref, &me)?.iter().filter(|l| l.target != order).count() as u32;
        if sold_to_others >= bag.quantity_total || now > bag.pickup_window_end.as_micros() + window {
            return Ok(Some(bag.title));
        }
    }
    Ok(None)
}

/// Refuses an order with a goodie bag the store can't sell it -- see
/// `unavailable_bag`.
pub(crate) fn ensure_bags_left(order: &ActionHash, lines: &[OrderLine]) -> ExternResult<()> {
    match unavailable_bag(order, lines)? {
        Some(title) => Err(guest(format!("{title} is sold out or no longer available, so this order can't be accepted -- decline it."))),
        None => Ok(()),
    }
}

/// Records the order's goodie bags as sold to it, once each -- with its
/// acceptance, in the same commit.
pub(crate) fn record_bag_sales(order: &ActionHash, lines: &[OrderLine]) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let order = original_action_of(order.clone())?;
    for (bag_ref, _) in bags_on(lines)? {
        if !sales_of(&bag_ref, &me)?.iter().any(|l| l.target == AnyLinkableHash::from(order.clone())) {
            create_link(bag_ref, order.clone(), LinkTypes::BagToOrder, ())?;
        }
    }
    Ok(())
}

/// A goodie bag as a customer sees it on its store's page: how many are
/// left, and whether they've ordered one already.
#[derive(Serialize, Deserialize, Debug)]
pub struct BagStanding {
    pub left: u32,
    pub ordered: bool,
}

/// `bags`' standings, in order -- the counts from the network (its store's
/// records of what it sold), the caller's orders from their own chain.
#[hdk_extern]
pub fn bag_standings(bags: Vec<ActionHash>) -> ExternResult<Vec<BagStanding>> {
    let mut standings = Vec::with_capacity(bags.len());
    for bag_ref in bags {
        let record = get(bag_ref.clone(), GetOptions::default())?.ok_or(guest("couldn't read that goodie bag"))?;
        let bag: GoodieBag = decode_or(&record).ok_or(guest("that isn't a goodie bag"))?;
        // Counted as its store counts them: the sales its owner recorded.
        let store = record.action().author().clone();
        let sold = get_links(LinkQuery::try_new(bag_ref.clone(), LinkTypes::BagToOrder)?.author(store), GetStrategy::default())?.len() as u32;
        standings.push(BagStanding { left: bag.quantity_total.saturating_sub(sold), ordered: crate::order_queues::ordered_bag(&bag_ref, bag.created_at)? });
    }
    Ok(standings)
}
