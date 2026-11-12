//! The member's side: their own orders at each store, worked into a card --
//! points, tier, history and what's on its way -- from their account there
//! (`accounts`), carried forward from what's still open.

use super::*;
use rewards_integrity::ledger::{OpenGrant, OpenOrder};

/// Every order of the caller's that joined a program, newest first: each
/// one's original action, its store, and when it was placed -- however
/// many. A walk of their whole chain: only for playing an account afresh,
/// or finding stores from before accounts kept a list.
pub(crate) fn my_orders() -> ExternResult<Vec<(ActionHash, ActionHash, Timestamp)>> {
    let orders: Vec<EntryType> = [dispatch_types::lineage::dispatch_entry_type(0)?, dispatch_types::lineage::dispatch_entry_type(3)?]
        .into_iter()
        .flatten()
        .map(|s| EntryType::App(AppEntryDef { entry_index: s.zome_type, zome_index: s.zome_index, visibility: EntryVisibility::Public }))
        .collect();
    let mut out = Vec::new();
    for record in mine(&orders).creates().records()? {
        if let Some(placed) = OrderForRewards::of(&record).filter(|o| o.rewards.is_some()) {
            out.push((record.action_address().clone(), placed.catalog_ref, record.action().timestamp()));
        }
    }
    Ok(out)
}

/// An order of the caller's, as an account holds it.
fn open_order(order: &ActionHash, placed_at: Timestamp) -> ExternResult<Option<OpenOrder>> {
    let Some(record) = get(order.clone(), GetOptions::local())? else { return Ok(None) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(None) };
    Ok(Some(OpenOrder { order: order.clone(), placed_at, accepted: None, reward: placed.rewards.as_ref().and_then(|r| r.reward), settled: None }))
}

/// The acceptance of an order by the store owner it names -- the key that
/// held the store when it was placed, which may since have moved it on.
pub(crate) fn acceptance_by_its_store(order: &ActionHash) -> ExternResult<Option<ActionHash>> {
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(None) };
    acceptance(order, &placed.merchant)
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
    /// Every point that's come in or gone out, newest first -- the latest
    /// `HISTORY` of them.
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
    /// Held at the store's earlier self, on the network before this one.
    Carried,
}

impl From<rewards_integrity::ledger::LedgerLine> for PointsLine {
    fn from(line: rewards_integrity::ledger::LedgerLine) -> Self {
        use rewards_integrity::ledger::LineKind;
        let (kind, note) = match line.kind {
            LineKind::Earned => (PointsLineKind::Earned, None),
            LineKind::Spent => (PointsLineKind::Spent, None),
            LineKind::Gift { note } => (PointsLineKind::Gift, note),
            LineKind::Birthday => (PointsLineKind::Birthday, None),
            LineKind::Carried => (PointsLineKind::Carried, None),
        };
        PointsLine { entry: line.entry, at: line.at, kind, points: line.points, note }
    }
}

/// The store's grants to the caller not folded into their account yet --
/// its own, and those of its earlier keys the caller has shown it.
fn grants_to_play(owner: &AgentPubKey, catalog_ref: &ActionHash, folded: &[ActionHash]) -> ExternResult<Vec<OpenGrant>> {
    let mut grants: Vec<OpenGrant> = grants_from(owner, catalog_ref, folded)?.into_iter().map(|g| open_grant(g.grant, g.at, &g.payload)).collect();
    for shown in carried::earlier_gifts(catalog_ref, &me()?)? {
        if !folded.contains(&shown.grant) && !grants.iter().any(|g| g.grant == shown.grant) {
            grants.push(shown);
        }
    }
    Ok(grants)
}

/// The caller's card at `catalog_ref`, from their account there: carried
/// forward from what's still open, or played afresh from every order of
/// theirs there when it must be (`accounts`). What it folds is kept.
pub(crate) fn card_for(catalog_ref: &ActionHash) -> ExternResult<CardView> {
    let store_info = store(catalog_ref)?;
    let Some(program) = program_of(catalog_ref.clone())? else {
        return Ok(CardView { catalog_ref: catalog_ref.clone(), store_name: store_info.business_name, program: None, state: None, balance: 0, reserved: 0, tier: 0, expires_at: None, pending: Vec::new(), pending_points: 0, history: Vec::new() });
    };
    let now = sys_time()?;
    let me = me()?;
    let found = account(catalog_ref, &me, false)?;
    let kept = found.value.clone();
    let prior = kept.as_ref().and_then(|a| a.ledger.as_ref()).filter(|l| l.program == program.version);
    let carried = match prior {
        Some(ledger) => play(&program, Some(ledger), &ledger.open_orders, grants_to_play(&store_info.owner, catalog_ref, &ledger.folded_grants)?, true, now)?.ok(),
        None => None,
    };
    let (folded, standing) = match carried {
        Some(carried) => carried,
        None => {
            // Played for the first time here: any gifts from the store's
            // earlier keys, or its network before, shown to it first.
            let _ = isolated::<_, u32>("reveal_my_gifts", catalog_ref.clone());
            let mut orders = Vec::new();
            // Their orders at the store and every store it carries on from.
            let line = store_line(catalog_ref)?;
            for (order, _, at) in my_orders()?.into_iter().filter(|(_, c, _)| line.contains(c)) {
                orders.extend(open_order(&order, at)?);
            }
            play(&program, None, &orders, grants_to_play(&store_info.owner, catalog_ref, &[])?, true, now)?.map_err(|_| guest("couldn't play this card's history"))?
        }
    };
    let latest_order = kept.as_ref().and_then(|a| a.latest_order.clone()).or_else(|| standing.iter().map(|(f, _)| &f.order).max_by_key(|o| o.placed_at).map(|o| o.order.clone()));
    keep_read(&found, MemberAccount { catalog_ref: catalog_ref.clone(), member: me, kept_by_store: false, ledger: Some(folded.ledger.clone()), latest_order, carried_at: None }, &folded);

    // Held for orders still waiting on the store, and what each order still
    // to earn should bring, in turn -- a welcome counts once.
    let mut reserved = 0u64;
    let mut on_the_way: Vec<(ActionHash, Timestamp, PointsStatus, u64)> = Vec::new();
    for (facts, now_) in &standing {
        if facts.order.accepted.is_none() && !facts.done {
            if let (Some(id), Some(cited)) = (facts.order.reward, program_cited(&facts.order.order)?) {
                reserved += cited.reward(id).map_or(0, |r| u64::from(r.cost));
            }
        }
        if let Some((status, base)) = now_.pending.clone().filter(|(s, _)| *s != PointsStatus::Earned) {
            on_the_way.push((facts.order.order.clone(), facts.order.placed_at, status, base));
        }
    }
    on_the_way.sort_by_key(|(_, at, ..)| *at);
    let mut preview = folded.state.clone();
    let mut pending = Vec::new();
    for (order, placed_at, status, base) in on_the_way {
        let Ok((next, points)) = step(&program.program, preview.as_ref(), Event::Earn { at: now, base }) else { continue };
        preview = Some(next);
        pending.push(OrderPoints { order, catalog_ref: catalog_ref.clone(), placed_at, points, status });
    }
    let (balance, tier, expires_at) = match &folded.state {
        Some(state) => (state.balance, tier_of(&program.program, state), expires_at(&program.program, state).filter(|_| state.balance > 0)),
        None => (0, 0, None),
    };
    let pending_points = pending.iter().map(|p| p.points).sum();
    let history = folded.history.into_iter().map(PointsLine::from).collect();
    Ok(CardView { catalog_ref: catalog_ref.clone(), store_name: store_info.business_name, program: Some(program), state: folded.state, balance: balance.saturating_sub(reserved), reserved, tier, expires_at, pending, pending_points, history })
}

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

/// The stores the caller has a card at, newest first: their list, or --
/// before they kept one -- every store their orders joined a program at,
/// kept as the list from then on.
pub(crate) fn my_card_stores() -> ExternResult<Vec<ActionHash>> {
    let stores = match my_stores()? {
        Some(stores) => stores,
        None => {
            let mut stores: Vec<ActionHash> = Vec::new();
            for (_, catalog_ref, _) in my_orders()? {
                if !stores.contains(&catalog_ref) {
                    stores.push(catalog_ref);
                }
            }
            let _ = isolated::<_, ()>("keep_my_stores_read", stores.clone());
            stores
        }
    };
    // A store its owner moved to a new key is carried on by its successor:
    // one card, the newest store's, with the points of every one before it.
    let mut current: Vec<ActionHash> = Vec::new();
    for store in stores {
        let newest = newest_in_line(store)?;
        if !current.contains(&newest) {
            current.push(newest);
        }
    }
    Ok(current)
}

/// The store `catalog_ref` carries on as now: its successor's successor, and
/// so on, as far as its owners moved it.
fn newest_in_line(catalog_ref: ActionHash) -> ExternResult<ActionHash> {
    let mut seen = vec![catalog_ref.clone()];
    let mut current = catalog_ref;
    loop {
        let next: Option<ActionHash> = call_local("catalog", "store_successor", current.clone())?.map_err(|why| guest(format!("store_successor: {why}")))?;
        match next {
            Some(next) if !seen.contains(&next) => {
                seen.push(next.clone());
                current = next;
            }
            _ => return Ok(current),
        }
    }
}

/// The caller's card at a store -- with the store's program even before
/// they've ordered there.
#[hdk_extern]
pub fn my_card(catalog_ref: ActionHash) -> ExternResult<CardView> {
    card_for(&catalog_ref)
}

/// Every card the caller holds: a store they've ordered from under its
/// program. Most recent first.
#[hdk_extern]
pub fn my_cards(_: ()) -> ExternResult<Vec<CardView>> {
    my_card_stores()?.iter().map(card_for).collect()
}

/// Notes an order the caller just placed in their account at its store, if
/// it joined a program: their card plays it from then on without reading
/// their chain. Called as the order is placed (dispatch), in the same call,
/// so an order is never placed without it.
#[hdk_extern]
pub fn note_my_order(order: ActionHash) -> ExternResult<()> {
    let Some(record) = get(order.clone(), GetOptions::local())? else { return Ok(()) };
    let Some(placed) = OrderForRewards::of(&record).filter(|o| o.rewards.is_some()) else { return Ok(()) };
    let me = me()?;
    if placed.requester != me {
        return Ok(());
    }
    // The store sees every gift it should count before it answers: shown,
    // in a call of its own, so it never stands in the order's way.
    let _ = isolated::<_, u32>("reveal_my_gifts", placed.catalog_ref.clone());
    let found = account(&placed.catalog_ref, &me, false)?;
    let kept = match found.value.clone() {
        Some(mut kept) => {
            // Not played yet: its first read plays every order there from
            // the chain, this one with them -- nothing to note until then.
            let Some(ledger) = kept.ledger.as_mut() else { return Ok(()) };
            if !ledger.open_orders.iter().any(|o| o.order == order) {
                ledger.open_orders.extend(open_order(&order, record.action().timestamp())?);
            }
            kept.latest_order = Some(order);
            kept
        }
        // Their first order here: the store goes on their list of cards.
        None => {
            add_my_stores(std::slice::from_ref(&placed.catalog_ref))?;
            MemberAccount { catalog_ref: placed.catalog_ref.clone(), member: me, kept_by_store: false, ledger: None, latest_order: Some(order), carried_at: None }
        }
    };
    keep(&found, kept)
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
    let card = card_for(&placed.catalog_ref)?;
    let Some(program) = card.program.as_ref() else { return Ok(None) };
    let Some(open) = open_order(&order, record.action().timestamp())? else { return Ok(None) };
    let now = sys_time()?;
    let (facts, now_) = facts(&open, true, now)?;
    if facts.order.accepted.is_none() {
        return Ok(None);
    }
    let Some((status, base)) = now_.pending else { return Ok(None) };
    // Still to come: what it'll earn at where the member stands now, which
    // doesn't count it yet. Earned: what it brought, as its card shows.
    let points = match card.pending.iter().find(|p| p.order == order) {
        Some(p) => p.points,
        None => card
            .history
            .iter()
            .find(|l| l.entry == order && l.kind == PointsLineKind::Earned)
            .map_or_else(|| step(&program.program, card.state.as_ref(), Event::Earn { at: now, base }).map_or(base, |(_, p)| p), |l| l.points.unsigned_abs()),
    };
    Ok(Some(OrderPoints { order, catalog_ref: placed.catalog_ref, placed_at: record.action().timestamp(), points, status }))
}
