//! What happened, as the rules see it: an order's events -- placed,
//! accepted, settled, appealed, given back -- read from the records that
//! prove them, for `rewards_types::points::replay` to work points out from.

use super::*;

/// One order that joined a store's program, as either side knows it.
pub(crate) struct MemberOrderView {
    pub(crate) order: ActionHash,
    pub(crate) placed_at: Timestamp,
    /// The store's acceptance of it, once it's accepted.
    pub(crate) accepted: Option<ActionHash>,
    /// The reward it spent (id), if it spent one.
    pub(crate) reward: Option<u16>,
}

/// Where an order's points stand, for the customer who placed it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum PointsStatus {
    /// On its way, or waiting on the store to settle it.
    Settling,
    /// Settled: earned once its refund period ends, at `until`.
    RefundPeriod { until: Timestamp },
    /// Appealed: earned once the arbiter rules.
    InReview,
    /// Earned.
    Earned,
}

/// An order's points: what it earns (an estimate, until it's earned) and
/// where that stands.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OrderPoints {
    pub order: ActionHash,
    pub catalog_ref: ActionHash,
    pub placed_at: Timestamp,
    pub points: u64,
    pub status: PointsStatus,
}

/// Mirrors dispatch's `AppealView`, as far as needed.
#[derive(Deserialize, Debug)]
pub(crate) struct AppealWire {
    pub(crate) ruling: Option<RulingWire>,
}

#[derive(Deserialize, Debug)]
pub(crate) struct RulingWire {
    pub(crate) ruling: ActionHash,
}

/// Mirrors `ledger::HoldView` and `ledger::WaiverView`, as far as needed.
#[derive(Deserialize, Debug)]
pub(crate) struct HoldWire {
    pub(crate) hold: ActionHash,
    pub(crate) purpose: dispatch_types::HoldPurpose,
}

#[derive(Deserialize, Debug)]
pub(crate) struct WaiverWire {
    pub(crate) portion: dispatch_types::Portion,
    pub(crate) by: AgentPubKey,
}

pub(crate) fn ledger<I: Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(function: &str, input: I) -> ExternResult<O> {
    call_local("ledger", function, input)?.map_err(|why| guest(format!("{function}: {why}")))
}

/// Whether the store (`merchant`) gave an order's food back: then whatever
/// reward it spent comes back too.
pub(crate) fn food_given_back(order: &ActionHash, merchant: &AgentPubKey) -> ExternResult<bool> {
    let holds: Vec<HoldWire> = ledger("holds_for_order", order.clone())?;
    for hold in holds.into_iter().filter(|h| h.purpose == dispatch_types::HoldPurpose::Food) {
        let waivers: Vec<WaiverWire> = ledger("waivers_for_hold", hold.hold)?;
        if waivers.iter().any(|w| w.portion == dispatch_types::Portion::Food && &w.by == merchant) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether `customer` may have a program's welcome bonus: a card the
/// network's issuer verified as new to it, on a network with issuers -- so
/// a welcome can't be farmed with fresh accounts.
pub(crate) fn may_be_welcomed(customer: &AgentPubKey) -> ExternResult<bool> {
    if handshake_governance::issuers().is_empty() {
        return Ok(true);
    }
    Ok(ledger::<_, bool>("card_verified", customer.clone()).unwrap_or(false))
}

/// What one accepted order means for points now: an earning (once its
/// refund period is over) or where it stands, and the reward it spent.
/// What happened, and where its points stand (with what they'd be, before
/// the member's tier) if they're still to come.
pub(crate) type OrderEvents = (Vec<Event>, Option<(PointsStatus, u64)>);

pub(crate) fn order_events(view: &MemberOrderView, merchant: &AgentPubKey, now: Timestamp) -> ExternResult<OrderEvents> {
    let mut events = Vec::new();
    let Some(accepted) = &view.accepted else { return Ok((events, None)) };
    let accepted_at = get(accepted.clone(), GetOptions::default())?.map_or(view.placed_at, |r| r.action().timestamp());
    // The reward it spent -- back again if the store gave the food back, or
    // the customer called it off in time.
    if let Some(id) = view.reward {
        if let Some(reward) = program_cited(&view.order)?.and_then(|p| p.reward(id).cloned()) {
            if !food_given_back(&view.order, merchant)? && !dispatch::<_, bool>("cancelled_in_time", view.order.clone())? {
                events.push(Event::Spend { at: accepted_at, cost: u64::from(reward.cost), min_tier: reward.min_tier });
            }
        }
    }
    let Some(settlement) = dispatch::<_, Option<ActionHash>>("order_settlement", view.order.clone())? else {
        // Not settled yet: an estimate from what was paid.
        let Some(record) = get(view.order.clone(), GetOptions::default())? else { return Ok((events, None)) };
        let Some(placed) = OrderForRewards::of(&record) else { return Ok((events, None)) };
        let Ok(lines) = line_totals(&placed)? else { return Ok((events, None)) };
        let Some(cited) = program_cited(&view.order)? else { return Ok((events, None)) };
        let base = rewards_integrity::order_points(&cited, &lines, placed.order_total.saturating_sub(placed.tax_cents), accepted_at);
        return Ok((events, (base > 0).then_some((PointsStatus::Settling, base))));
    };
    let appeal = dispatch::<_, Option<AppealWire>>("get_appeal_for_order", view.order.clone())?;
    let ruling = appeal.as_ref().and_then(|a| a.ruling.as_ref().map(|r| r.ruling.clone()));
    let Ok(earning) = earning(&view.order, &settlement, accepted, ruling.as_ref())? else { return Ok((events, None)) };
    if earning.base == 0 {
        return Ok((events, None));
    }
    let ended = if earning.available_at > earning.settled_at { now > earning.available_at } else { now >= earning.settled_at };
    let status = match (&appeal, &ruling) {
        (Some(_), None) => PointsStatus::InReview,
        _ if !ended => PointsStatus::RefundPeriod { until: earning.available_at },
        _ => {
            events.push(Event::Earn { at: earning.settled_at, base: earning.base });
            PointsStatus::Earned
        }
    };
    Ok((events, Some((status, earning.base))))
}

/// The program version an order (its original action) cites.
pub(crate) fn program_cited(order: &ActionHash) -> ExternResult<Option<RewardsProgram>> {
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(None) };
    let Some(rewards) = placed.rewards else { return Ok(None) };
    Ok(program_at(&rewards.program, &placed.catalog_ref)?.ok())
}

/// A member's standing at a store, worked out from what happened.
pub(crate) struct Standing {
    pub(crate) state: Option<PointsState>,
    /// What each order or grant moved, oldest first, by what it came from.
    pub(crate) log: Vec<(ActionHash, Event, i64)>,
    /// Orders whose points are on their way, oldest first.
    pub(crate) pending: Vec<OrderPoints>,
}

/// `grants`: each grant's record, when, and its points.
pub(crate) fn standing(catalog_ref: &ActionHash, customer: &AgentPubKey, merchant: &AgentPubKey, program: &RewardsProgram, orders: Vec<MemberOrderView>, grants: Vec<(ActionHash, Timestamp, u32)>) -> ExternResult<Standing> {
    let now = sys_time()?;
    let mut events: Vec<(Event, ActionHash)> = grants.into_iter().map(|(grant, at, points)| (Event::Credit { at, points: u64::from(points) }, grant)).collect();
    let mut on_the_way: Vec<(ActionHash, Timestamp, PointsStatus, u64)> = Vec::new();
    for view in &orders {
        let (happened, pending) = order_events(view, merchant, now)?;
        events.extend(happened.into_iter().map(|e| (e, view.order.clone())));
        if let Some((status, base)) = pending.filter(|(s, _)| *s != PointsStatus::Earned) {
            on_the_way.push((view.order.clone(), view.placed_at, status, base));
        }
    }
    let welcome = may_be_welcomed(customer)?;
    let (state, log) = replay(program, events, welcome);
    let state = state.map(|s| roll(program, &s, now));
    // What each pending order should bring, in turn -- a welcome counts once.
    on_the_way.sort_by_key(|(_, at, ..)| *at);
    let mut rules = program.clone();
    if !welcome {
        rules.earn.welcome_bonus = 0;
    }
    let mut preview = state.clone();
    let mut pending = Vec::new();
    for (order, placed_at, status, base) in on_the_way {
        let Ok((next, points)) = step(&rules, preview.as_ref(), Event::Earn { at: now, base }) else { continue };
        preview = Some(next);
        pending.push(OrderPoints { order, catalog_ref: catalog_ref.clone(), placed_at, points, status });
    }
    Ok(Standing { state, log, pending })
}
