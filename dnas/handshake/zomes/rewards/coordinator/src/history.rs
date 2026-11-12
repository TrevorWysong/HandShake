//! What happened, as the rules see it: an order's events -- placed,
//! accepted, settled, appealed, given back -- read from the records that
//! prove them, for `rewards_types::points::replay` to work points out from.

use super::*;

/// One order that joined a store's program, as either side knows it.
pub(crate) struct MemberOrderView {
    pub(crate) order: ActionHash,
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

/// Whether the store let an order's food go -- settled the customer's
/// payment without charging for it: then whatever reward it spent comes
/// back too.
pub(crate) fn food_given_back(order: &ActionHash) -> ExternResult<bool> {
    dispatch::<_, bool>("food_given_back", order.clone())
}

/// What one order means for points now: the events it's brought about,
/// where its earning stands if that's still to come (with what it'd be,
/// before the member's tier), and whether any of that can still change.
pub(crate) struct OrderNow {
    pub(crate) events: Vec<Event>,
    pub(crate) pending: Option<(PointsStatus, u64)>,
    /// Nothing about it can change any more: it ended without the store
    /// accepting it, or it's settled and earned (or earns nothing). Until
    /// then it isn't folded into anyone's ledger -- including when what it
    /// earns can't be read just now.
    pub(crate) done: bool,
    /// What its settlement fixed, when it's settled, earns something and
    /// nobody has appealed it -- for the account to keep (`Settled`).
    pub(crate) settled: Option<rewards_integrity::ledger::Settled>,
}

pub(crate) fn order_now(view: &MemberOrderView, now: Timestamp) -> ExternResult<OrderNow> {
    let mut events = Vec::new();
    let unknown = |events| Ok(OrderNow { events, pending: None, done: false, settled: None });
    let Some(accepted) = &view.accepted else {
        // Never accepted: it spends and earns nothing, and is done once
        // it's called off (cancelled, or declined).
        return Ok(OrderNow { events, pending: None, done: order_called_off(&view.order)?, settled: None });
    };
    // The order and the store's acceptance of it are validated as there:
    // one not read yet is an error -- left out, a spend would go uncounted
    // and the member's balance read high.
    let accepted_at = arrived(accepted)?.action().timestamp();
    // The reward it spent -- back again if the store gave the food back, or
    // the customer called it off in time.
    let mut spend = None;
    if let Some(id) = view.reward {
        if let Some(reward) = program_cited(&view.order)?.and_then(|p| p.reward(id).cloned()) {
            if !food_given_back(&view.order)? && !dispatch::<_, bool>("cancelled_in_time", view.order.clone())? {
                events.push(Event::Spend { at: accepted_at, cost: u64::from(reward.cost), min_tier: reward.min_tier });
                spend = Some((accepted_at, u64::from(reward.cost), reward.min_tier));
            }
        }
    }
    let Some(settlement) = dispatch::<_, Option<ActionHash>>("order_settlement", view.order.clone())? else {
        // Not settled yet: an estimate from what was paid.
        let Some(placed) = OrderForRewards::of(&arrived(&view.order)?) else { return unknown(events) };
        let Ok(lines) = line_totals(&placed)? else { return unknown(events) };
        let Some(cited) = program_cited(&view.order)? else { return unknown(events) };
        let base = rewards_integrity::order_points(&cited, &lines, placed.order_total.saturating_sub(placed.tax_cents), accepted_at);
        return Ok(OrderNow { events, pending: (base > 0).then_some((PointsStatus::Settling, base)), done: false, settled: None });
    };
    let appeal = dispatch::<_, Option<AppealWire>>("get_appeal_for_order", view.order.clone())?;
    let ruling = appeal.as_ref().and_then(|a| a.ruling.as_ref().map(|r| r.ruling.clone()));
    let Ok(earning) = earning(&view.order, &settlement, accepted, ruling.as_ref())? else { return unknown(events) };
    if earning.base == 0 {
        // Settled and earning nothing: an award only ever takes away.
        return Ok(OrderNow { events, pending: None, done: true, settled: None });
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
    let done = status == PointsStatus::Earned;
    let settled = appeal.is_none().then_some(rewards_integrity::ledger::Settled { spend, settled_at: earning.settled_at, base: earning.base, available_at: earning.available_at, closed: false }).map(|s| rewards_integrity::ledger::Settled { closed: s.closes(now), ..s });
    Ok(OrderNow { events, pending: Some((status, earning.base)), done, settled })
}

/// The program version an order (its original action) cites.
pub(crate) fn program_cited(order: &ActionHash) -> ExternResult<Option<RewardsProgram>> {
    let Some(placed) = OrderForRewards::of(&arrived(order)?) else { return Ok(None) };
    let Some(rewards) = placed.rewards else { return Ok(None) };
    Ok(program_at(&rewards.program, &placed.catalog_ref)?.ok())
}
