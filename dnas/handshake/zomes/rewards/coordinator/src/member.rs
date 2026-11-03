//! The member's side: their own orders at each store, worked into a card --
//! points, tier, history and what's on its way.

use super::*;

/// The caller's orders that joined a program, newest first: each one's
/// original action, its store, and when it was placed.
pub(crate) fn my_orders() -> ExternResult<Vec<(ActionHash, ActionHash, Timestamp)>> {
    let orders: Vec<EntryType> = [dispatch_types::lineage::dispatch_entry_type(0)?, dispatch_types::lineage::dispatch_entry_type(3)?]
        .into_iter()
        .flatten()
        .map(|s| EntryType::App(AppEntryDef { entry_index: s.zome_type, zome_index: s.zome_index, visibility: EntryVisibility::Public }))
        .collect();
    let mut out = Vec::new();
    for record in mine(&orders).creates().records()?.into_iter().take(MAX_ORDERS_READ) {
        if let Some(placed) = OrderForRewards::of(&record).filter(|o| o.rewards.is_some()) {
            out.push((record.action_address().clone(), placed.catalog_ref, record.action().timestamp()));
        }
    }
    Ok(out)
}

/// The most of their own orders a member's card reads.
pub(crate) const MAX_ORDERS_READ: usize = 500;

/// The caller's view of one of their orders: whether, and when, the store
/// accepted it, and the reward it spent. An order the store never accepted
/// -- cancelled first, or declined -- spends nothing and earns nothing.
pub(crate) fn my_order_view(order: &ActionHash, placed_at: Timestamp) -> ExternResult<Option<MemberOrderView>> {
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(None) };
    let reward = placed.rewards.as_ref().and_then(|r| r.reward);
    let accepted = acceptance(order, &placed.merchant)?;
    Ok(Some(MemberOrderView { order: order.clone(), placed_at, accepted, reward }))
}

/// The store's acceptance of an order: its earliest update from `Placed`
/// that doesn't call it off (a decline is an update from `Placed` too).
pub(crate) fn acceptance(order: &ActionHash, merchant: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    let mut found: Option<(Timestamp, ActionHash)> = None;
    let mut frontier = vec![order.clone()];
    while let Some(hash) = frontier.pop() {
        let Some(Details::Record(details)) = get_details(hash, GetOptions::default())? else { continue };
        frontier.extend(details.updates.iter().map(|u| u.action_address().clone()));
        let record = details.record;
        let declines = decode_or::<dispatch_types::DeliveryOrder>(&record).map(|o| o.cancellation.is_some()).or_else(|| decode_or::<dispatch_types::PickupOrder>(&record).map(|o| o.cancellation.is_some())).unwrap_or(true);
        if record.action().author() == merchant && !declines && matches!(record.action().data, ActionData::Update(_)) && accepted_at(order, merchant, record.action_address())?.is_ok() && found.as_ref().is_none_or(|(at, _)| record.action().timestamp() < *at) {
            found = Some((record.action().timestamp(), record.action_address().clone()));
        }
    }
    Ok(found.map(|(_, hash)| hash))
}

/// A member's card at a store: where they stand now, and what's coming.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CardView {
    pub catalog_ref: ActionHash,
    pub store_name: String,
    pub program: Option<ProgramView>,
    pub state: Option<PointsState>,
    /// What they can spend now.
    pub balance: u64,
    /// Points their orders still waiting on the store would spend.
    pub reserved: u64,
    pub tier: u8,
    /// When their points expire, if they do.
    pub expires_at: Option<Timestamp>,
    /// Orders still to earn here, oldest first -- and what they'll bring.
    pub pending: Vec<OrderPoints>,
    pub pending_points: u64,
    /// Every point that's come in or gone out, newest first.
    pub history: Vec<PointsLine>,
}

/// One line of a member's history at a store.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PointsLine {
    /// What it came from: the order, or the store's grant.
    pub entry: ActionHash,
    pub at: Timestamp,
    pub kind: PointsLineKind,
    /// Points in (positive) or out (negative), as it stood then.
    pub points: i64,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum PointsLineKind {
    Earned,
    Spent,
    Gift,
    Birthday,
}

pub(crate) fn card_for(catalog_ref: &ActionHash, orders: Vec<(ActionHash, Timestamp)>) -> ExternResult<CardView> {
    let program = program_of(catalog_ref.clone())?;
    let store_info = store(catalog_ref)?;
    let grants = grants_from(&store_info.owner, catalog_ref)?;
    let mut views = Vec::new();
    let mut reserved = 0u64;
    for (order, placed_at) in orders {
        let Some(view) = my_order_view(&order, placed_at)? else { continue };
        if view.accepted.is_none() {
            // Placed, not yet accepted: a reward it names is held for it.
            if let (Some(id), Some(cited)) = (view.reward, program_cited(&order)?) {
                if !order_called_off(&order)? {
                    reserved += cited.reward(id).map_or(0, |r| u64::from(r.cost));
                }
            }
            continue;
        }
        views.push(view);
    }
    let theirs: Vec<&GrantToMe> = grants.iter().collect();
    let Some(view) = program.clone() else {
        return Ok(CardView { catalog_ref: catalog_ref.clone(), store_name: store_info.business_name, program, state: None, balance: 0, reserved, tier: 0, expires_at: None, pending: Vec::new(), pending_points: 0, history: Vec::new() });
    };
    let grants: Vec<(ActionHash, Timestamp, u32)> = theirs.iter().map(|g| (g.grant.clone(), g.at, g.payload.points)).collect();
    let standing = standing(catalog_ref, &view.program, views, grants)?;
    // What each moved, as the rules played it.
    let mut history: Vec<PointsLine> = standing
        .log
        .iter()
        .map(|(entry, event, points)| {
            let grant = theirs.iter().find(|g| &g.grant == entry);
            let (kind, note) = match (event, grant.map(|g| &g.payload.reason)) {
                (Event::Earn { .. }, _) => (PointsLineKind::Earned, None),
                (Event::Spend { .. }, _) => (PointsLineKind::Spent, None),
                (Event::Credit { .. }, Some(GrantReason::Birthday { .. })) => (PointsLineKind::Birthday, None),
                (Event::Credit { .. }, Some(GrantReason::Goodwill { note })) => (PointsLineKind::Gift, (!note.is_empty()).then(|| note.clone())),
                (Event::Credit { .. }, None) => (PointsLineKind::Gift, None),
            };
            PointsLine { entry: entry.clone(), at: event.at(), kind, points: *points, note }
        })
        .collect();
    history.reverse();
    history.truncate(HISTORY);
    let (balance, tier, expires_at) = match &standing.state {
        Some(state) => (state.balance, tier_of(&view.program, state), expires_at(&view.program, state).filter(|_| state.balance > 0)),
        None => (0, 0, None),
    };
    let pending_points = standing.pending.iter().map(|p| p.points).sum();
    Ok(CardView { catalog_ref: catalog_ref.clone(), store_name: store_info.business_name, program, state: standing.state, balance: balance.saturating_sub(reserved), reserved, tier, expires_at, pending: standing.pending, pending_points, history })
}

pub(crate) const HISTORY: usize = 30;

/// Whether an order was called off: any of its versions cancels it.
pub(crate) fn order_called_off(order: &ActionHash) -> ExternResult<bool> {
    let mut frontier = vec![order.clone()];
    while let Some(hash) = frontier.pop() {
        let Some(Details::Record(details)) = get_details(hash, GetOptions::default())? else { continue };
        frontier.extend(details.updates.iter().map(|u| u.action_address().clone()));
        let cancelled = decode_or::<dispatch_types::DeliveryOrder>(&details.record).map(|o| o.cancellation.is_some()).or_else(|| decode_or::<dispatch_types::PickupOrder>(&details.record).map(|o| o.cancellation.is_some()));
        if cancelled == Some(true) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The caller's card at a store -- with the store's program even before
/// they've ordered there.
#[hdk_extern]
pub fn my_card(catalog_ref: ActionHash) -> ExternResult<CardView> {
    let orders = my_orders()?.into_iter().filter(|(_, c, _)| c == &catalog_ref).map(|(o, _, at)| (o, at)).collect();
    card_for(&catalog_ref, orders)
}

/// Every card the caller holds: a store they've ordered from under its
/// program. Most recent first.
#[hdk_extern]
pub fn my_cards(_: ()) -> ExternResult<Vec<CardView>> {
    let mut stores: Vec<(ActionHash, Vec<(ActionHash, Timestamp)>)> = Vec::new();
    for (order, catalog_ref, at) in my_orders()? {
        match stores.iter_mut().find(|(s, _)| s == &catalog_ref) {
            Some((_, list)) => list.push((order, at)),
            None => stores.push((catalog_ref, vec![(order, at)])),
        }
    }
    stores.into_iter().map(|(store, orders)| card_for(&store, orders)).collect()
}

/// One of the caller's orders, as its points stand -- for its order page.
#[hdk_extern]
pub fn order_points(order: ActionHash) -> ExternResult<Option<OrderPoints>> {
    let order = original_action_of(order)?;
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(None) };
    if placed.requester != me()? || placed.rewards.is_none() {
        return Ok(None);
    }
    let Some(program) = program_of(placed.catalog_ref.clone())? else { return Ok(None) };
    let Some(view) = my_order_view(&order, record.action().timestamp())? else { return Ok(None) };
    if view.accepted.is_none() {
        return Ok(None);
    }
    let (_, status) = order_events(&view, sys_time()?)?;
    let Some((status, base)) = status else { return Ok(None) };
    // What it earns at the member's standing without it.
    let card = card_for(&placed.catalog_ref, my_orders()?.into_iter().filter(|(o, c, _)| c == &placed.catalog_ref && o != &order).map(|(o, _, at)| (o, at)).collect())?;
    let rules = program.program.clone();
    let points = step(&rules, card.state.as_ref(), Event::Earn { at: sys_time()?, base }).map_or(base, |(_, p)| p);
    Ok(Some(OrderPoints { order, catalog_ref: placed.catalog_ref, placed_at: record.action().timestamp(), points, status }))
}
