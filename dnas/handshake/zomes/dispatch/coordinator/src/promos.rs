//! A promo code's limits (`catalog_types::PromoLimits`), from both sides:
//! the customer's standing with each of a store's live codes -- what the app
//! shows before they order, as validation will hold them to it -- and the
//! store's count of a code's uses across customers, which it holds orders to
//! as it accepts them (`total`).

use catalog_types::{PromoCode, PromoLimits, PromoPeriod};
use dispatch_integrity::*;
use handshake_coordinator_support::chain::mine;
use handshake_coordinator_support::{call_local, decode_or, guest, original_action_of};
use hdk::prelude::*;

/// Why a customer can't use a code now.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum PromoBlock {
    /// It's for a first order here, and they've ordered here before.
    FirstOrderOnly,
    /// They've used it as many times as it allows.
    UsedUp,
    /// They've used it already this day, week or month.
    ThisPeriod(PromoPeriod),
    /// Every use it allows, across customers, is taken.
    SoldOut,
}

/// A customer's standing with one of a store's codes.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PromoStanding {
    /// The code (its original action).
    pub promo: ActionHash,
    /// How many of their orders have used it.
    pub uses: u32,
    /// How many uses are left across every customer, for a code with a total.
    pub remaining: Option<u32>,
    /// Why they can't use it now -- `None` if they can.
    pub blocked: Option<PromoBlock>,
}

/// The caller's own orders, newest first: each one's store, the promo it
/// cites (by its original action) and when it was placed -- less those that
/// came to nothing before the store took them on, which use up no promo
/// (as validation counts them: `dispatch_integrity::checks::earlier_orders`).
fn my_orders() -> ExternResult<Vec<(ActionHash, Option<ActionHash>, Timestamp)>> {
    let types = [EntryType::try_from(UnitEntryTypes::DeliveryOrder)?, EntryType::try_from(UnitEntryTypes::PickupOrder)?];
    let confirmation = EntryType::try_from(UnitEntryTypes::OrderConfirmation)?;
    let notes = [confirmation.clone(), EntryType::try_from(UnitEntryTypes::DeclineNoted)?];
    let (mut confirmed, mut declined, mut cancelled) = (Vec::new(), Vec::new(), Vec::new());
    // Told apart by type: the two have the same fields, so either decodes
    // as the other.
    for record in mine(&notes).records()? {
        if record.action().entry_type() == Some(&confirmation) {
            confirmed.extend(decode_or::<OrderConfirmation>(&record).map(|c| c.order));
        } else {
            declined.extend(decode_or::<DeclineNoted>(&record).map(|d| d.order));
        }
    }
    let mut orders = Vec::new();
    for record in mine(&types).records()? {
        let cited = decode_or::<DeliveryOrder>(&record).map(|o| (o.catalog_ref, o.promo_code_ref, o.cancellation.is_some(), o.merchant)).or_else(|| decode_or::<PickupOrder>(&record).map(|o| (o.catalog_ref, o.promo_code_ref, o.cancellation.is_some(), o.merchant)));
        let Some((catalog_ref, promo, has_cancellation, merchant)) = cited else { continue };
        if matches!(record.action().data, ActionData::Update(_)) {
            if has_cancellation {
                let original = original_action_of(record.action_address().clone())?;
                // Cancelled on the store's started version: seen started.
                if dispatch_integrity::lineage::cancels_started(record.action_address(), &merchant)? {
                    confirmed.push(original.clone());
                }
                cancelled.push(original);
            }
            continue;
        }
        let promo = promo.map(original_action_of).transpose()?;
        orders.push((record.action_address().clone(), catalog_ref, promo, record.action().timestamp()));
    }
    Ok(orders
        .into_iter()
        .filter(|(order, ..)| !declined.contains(order) && !(cancelled.contains(order) && !confirmed.contains(order)))
        .map(|(_, catalog_ref, promo, at)| (catalog_ref, promo, at))
        .collect())
}

/// How many orders a code's store has accepted with it.
pub(crate) fn uses_of(promo: &ActionHash, store_owner: &AgentPubKey, strategy: GetStrategy) -> ExternResult<u32> {
    let mut orders: Vec<AnyLinkableHash> = get_links(LinkQuery::try_new(promo.clone(), LinkTypes::PromoToOrder)?.author(store_owner.clone()), strategy)?.into_iter().map(|l| l.target).collect();
    orders.sort();
    orders.dedup();
    Ok(orders.len() as u32)
}

/// The caller's standing with a code, from their own orders -- the rules
/// validation holds an order to (`dispatch_integrity::checks`), and the
/// store's count of its uses.
fn standing(promo_ref: &ActionHash, promo: &PromoCode, store: &catalog_types::MerchantCatalog, orders: &[(ActionHash, Option<ActionHash>, Timestamp)]) -> ExternResult<PromoStanding> {
    let identity = original_action_of(promo_ref.clone())?;
    let limits: &PromoLimits = &promo.limits;
    let here: Vec<&(ActionHash, Option<ActionHash>, Timestamp)> = orders.iter().filter(|(c, _, _)| c == &promo.catalog_ref).collect();
    let uses: Vec<Timestamp> = here.iter().filter(|(_, p, _)| p.as_ref() == Some(&identity)).map(|(_, _, at)| *at).collect();
    let remaining = match limits.total {
        Some(total) => Some(total.saturating_sub(uses_of(&identity, &store.owner, GetStrategy::default())?)),
        None => None,
    };
    let now = sys_time()?;
    let blocked = if limits.first_order_only && !here.is_empty() {
        Some(PromoBlock::FirstOrderOnly)
    } else if limits.per_customer.is_some_and(|n| uses.len() >= n as usize) {
        Some(PromoBlock::UsedUp)
    } else if let Some(period) = limits.once_per.filter(|p| uses.iter().any(|at| rewards_types::period_of(*at, &store.time_zone, *p) == rewards_types::period_of(now, &store.time_zone, *p))) {
        Some(PromoBlock::ThisPeriod(period))
    } else if remaining == Some(0) {
        Some(PromoBlock::SoldOut)
    } else {
        None
    };
    Ok(PromoStanding { promo: identity, uses: uses.len() as u32, remaining, blocked })
}

/// The caller's standing with each of a store's live codes.
#[hdk_extern]
pub fn my_promo_standing(catalog_ref: ActionHash) -> ExternResult<Vec<PromoStanding>> {
    let store = crate::stores::current_catalog(&catalog_ref)?;
    #[derive(Deserialize, Debug)]
    struct PromoViewWire {
        original_action: ActionHash,
        record: Record,
    }
    let views: Vec<PromoViewWire> = call_local("catalog", "list_live_promo_codes", catalog_ref)?.map_err(|_| guest("reading the store's promo codes failed"))?;
    let orders = my_orders()?;
    views.into_iter().filter_map(|v| decode_or::<PromoCode>(&v.record).map(|p| (v.original_action, p))).map(|(hash, promo)| standing(&hash, &promo, &store, &orders)).collect()
}

/// Refuses a code the caller can't use, before the order is written --
/// plainly, where validation would refuse it with a diagnostic.
pub(crate) fn ensure_promo_allowed(promo_ref: &ActionHash, catalog_ref: &ActionHash) -> ExternResult<()> {
    let Some(promo) = get(promo_ref.clone(), GetOptions::default())?.and_then(|r| decode_or::<PromoCode>(&r)) else { return Ok(()) };
    if &promo.catalog_ref != catalog_ref {
        return Ok(());
    }
    let store = crate::stores::current_catalog(catalog_ref)?;
    match standing(promo_ref, &promo, &store, &my_orders()?)?.blocked {
        None => Ok(()),
        Some(PromoBlock::FirstOrderOnly) => Err(guest("That promo code is for your first order here.")),
        Some(PromoBlock::UsedUp) => Err(guest("You've used that promo code as many times as it allows.")),
        Some(PromoBlock::ThisPeriod(_)) => Err(guest("You've already used that promo code this time around. Try again later.")),
        Some(PromoBlock::SoldOut) => Err(guest("That promo code has been used up.")),
    }
}

/// The store's check before accepting an order with a code that has a total:
/// uses left. Counted from the store's own record of the orders it accepted
/// with it.
pub(crate) fn promo_used_up(order: &ActionHash, promo_ref: Option<&ActionHash>) -> ExternResult<bool> {
    let Some(promo_ref) = promo_ref else { return Ok(false) };
    let Some(promo) = get(promo_ref.clone(), GetOptions::default())?.and_then(|r| decode_or::<PromoCode>(&r)) else { return Ok(false) };
    let Some(total) = promo.limits.total else { return Ok(false) };
    let identity = original_action_of(promo_ref.clone())?;
    let me = agent_info()?.agent_initial_pubkey;
    let order: AnyLinkableHash = original_action_of(order.clone())?.into();
    let counted = get_links(LinkQuery::try_new(identity.clone(), LinkTypes::PromoToOrder)?.author(me.clone()), GetStrategy::Local)?;
    if counted.iter().any(|l| l.target == order) {
        return Ok(false);
    }
    Ok(uses_of(&identity, &me, GetStrategy::Local)? >= total)
}

/// Refuses an order whose code is used up -- see `promo_used_up`.
pub(crate) fn ensure_promo_left(order: &ActionHash, promo_ref: Option<&ActionHash>) -> ExternResult<()> {
    if promo_used_up(order, promo_ref)? {
        return Err(guest("This order's promo code has been used as many times as it allows, so it can't be accepted -- decline it."));
    }
    Ok(())
}

/// Counts an accepted order against its code's total, once.
pub(crate) fn record_promo_use(order: &ActionHash, promo_ref: Option<&ActionHash>) -> ExternResult<()> {
    let Some(promo_ref) = promo_ref else { return Ok(()) };
    let identity = original_action_of(promo_ref.clone())?;
    let order = original_action_of(order.clone())?;
    let me = agent_info()?.agent_initial_pubkey;
    let counted = get_links(LinkQuery::try_new(identity.clone(), LinkTypes::PromoToOrder)?.author(me), GetStrategy::Local)?;
    if !counted.iter().any(|l| l.target == AnyLinkableHash::from(order.clone())) {
        create_link(identity, order, LinkTypes::PromoToOrder, ())?;
    }
    Ok(())
}

/// How many orders the caller's store has accepted with a code -- for its
/// list of codes.
#[hdk_extern]
pub fn my_promo_uses(promo: ActionHash) -> ExternResult<u32> {
    uses_of(&original_action_of(promo)?, &agent_info()?.agent_initial_pubkey, GetStrategy::Local)
}
