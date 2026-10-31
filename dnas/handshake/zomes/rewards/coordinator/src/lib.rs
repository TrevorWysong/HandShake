//! Coordinator zome for rewards: a store's program, and its members' points.
//! Points are private between a member and a store: nothing about them is
//! published. Both sides work them out with the same pure rules
//! (`rewards_types::points::replay`) -- the store from its own records
//! (the orders it accepted from the member, its settlements, its grants)
//! before it honours a reward; the member's app from their own orders, to
//! show them where they stand and what's on its way. See docs/REWARDS.md.

use handshake_coordinator_support::chain::{my_current_version, my_versions, mine};
use handshake_coordinator_support::{decode_or, guest, open, original_action_of, resolve_version, seal, update_version};
use hdk::prelude::*;
use rewards_integrity::*;

fn me() -> ExternResult<AgentPubKey> {
    Ok(agent_info()?.agent_initial_pubkey)
}

fn dispatch<I: Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(function: &str, input: I) -> ExternResult<O> {
    match call(CallTargetCell::Local, "dispatch", function.into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        other => Err(guest(format!("{function}: {other:?}"))),
    }
}

/// The store `catalog_ref` is, and its owner.
fn store(catalog_ref: &ActionHash) -> ExternResult<catalog_types::MerchantCatalog> {
    let record = get(catalog_ref.clone(), GetOptions::default())?.ok_or(guest("That store couldn't be found."))?;
    decode_or(&record).ok_or(guest("That isn't a store."))
}

// --- programs ---

/// A store's program at its current version.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProgramView {
    /// The program's identity (its original action).
    pub original: ActionHash,
    /// Its current version -- what an order placed now cites.
    pub version: ActionHash,
    pub program: RewardsProgram,
}

fn program_links(catalog_ref: &ActionHash) -> ExternResult<Vec<Link>> {
    get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToProgram)?, GetStrategy::default())
}

/// `catalog_ref`'s program, current -- `None` if it has none. Only one its
/// owner wrote counts (validation allows no other).
#[hdk_extern]
pub fn program_of(catalog_ref: ActionHash) -> ExternResult<Option<ProgramView>> {
    let owner = store(&catalog_ref)?.owner;
    for link in program_links(&catalog_ref)? {
        let Some(original) = link.target.into_action_hash() else { continue };
        let Ok(current) = resolve_version(original.clone()) else { continue };
        if current.record.action().author() != &owner {
            continue;
        }
        if let Some(program) = decode_or::<RewardsProgram>(&current.record).filter(|p| p.catalog_ref == catalog_ref) {
            return Ok(Some(ProgramView { original, version: current.record.action_address().clone(), program }));
        }
    }
    Ok(None)
}

/// The caller's own program for their store, read from their chain.
fn my_program(catalog_ref: &ActionHash) -> ExternResult<Option<handshake_coordinator_support::EntryVersion>> {
    let types = [EntryType::try_from(UnitEntryTypes::RewardsProgram)?];
    let Some(original) = mine(&types).creates().find(|r| decode_or::<RewardsProgram>(r).is_some_and(|p| &p.catalog_ref == catalog_ref))? else { return Ok(None) };
    my_current_version(original.action_address().clone())
}

/// Sets up or changes the caller's store's program. Returns its current
/// version.
#[hdk_extern]
pub fn save_program(program: RewardsProgram) -> ExternResult<ActionHash> {
    if store(&program.catalog_ref)?.owner != me()? {
        return Err(guest("Only the store's owner can run its rewards program."));
    }
    if let Some(problem) = program.problem() {
        return Err(guest(problem));
    }
    let catalog_ref = program.catalog_ref.clone();
    match my_program(&catalog_ref)? {
        Some(current) => update_version(&current, &EntryTypes::RewardsProgram(program), LinkTypes::Version),
        None => {
            let hash = create_entry(&EntryTypes::RewardsProgram(program))?;
            create_link(catalog_ref, hash.clone(), LinkTypes::CatalogToProgram, ())?;
            Ok(hash)
        }
    }
}

/// One version of a program, as its store's chain holds it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProgramVersion {
    pub action: ActionHash,
    pub written_at: Timestamp,
}

/// The caller's store's program, every version oldest first, from their own
/// chain -- what the store checks an order's cited version against before
/// accepting it (dispatch's `ensure_current_program`).
#[hdk_extern]
pub fn get_my_program_versions(catalog_ref: ActionHash) -> ExternResult<Vec<ProgramVersion>> {
    let types = [EntryType::try_from(UnitEntryTypes::RewardsProgram)?];
    let Some(original) = mine(&types).creates().find(|r| decode_or::<RewardsProgram>(r).is_some_and(|p| p.catalog_ref == catalog_ref))? else { return Ok(Vec::new()) };
    Ok(my_versions(original.action_address().clone())?.into_iter().map(|r| ProgramVersion { action: r.action_address().clone(), written_at: r.action().timestamp() }).collect())
}

// --- what happened, as the rules see it ---

/// One order that joined a store's program, as either side knows it.
struct MemberOrderView {
    order: ActionHash,
    placed_at: Timestamp,
    /// The store's acceptance of it, once it's accepted.
    accepted: Option<ActionHash>,
    /// The reward it spent (id), if it spent one.
    reward: Option<u16>,
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
struct AppealWire {
    ruling: Option<RulingWire>,
}

#[derive(Deserialize, Debug)]
struct RulingWire {
    ruling: ActionHash,
}

/// Mirrors `ledger::HoldView` and `ledger::WaiverView`, as far as needed.
#[derive(Deserialize, Debug)]
struct HoldWire {
    hold: ActionHash,
    purpose: dispatch_types::HoldPurpose,
}

#[derive(Deserialize, Debug)]
struct WaiverWire {
    portion: dispatch_types::Portion,
    by: AgentPubKey,
}

fn ledger<I: Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(function: &str, input: I) -> ExternResult<O> {
    match call(CallTargetCell::Local, "ledger", function.into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        other => Err(guest(format!("{function}: {other:?}"))),
    }
}

/// Whether the store (`merchant`) gave an order's food back: then whatever
/// reward it spent comes back too.
fn food_given_back(order: &ActionHash, merchant: &AgentPubKey) -> ExternResult<bool> {
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
fn may_be_welcomed(customer: &AgentPubKey) -> ExternResult<bool> {
    if handshake_governance::issuers().is_empty() {
        return Ok(true);
    }
    Ok(ledger::<_, bool>("card_verified", customer.clone()).unwrap_or(false))
}

/// What one accepted order means for points now: an earning (once its
/// refund period is over) or where it stands, and the reward it spent.
/// What happened, and where its points stand (with what they'd be, before
/// the member's tier) if they're still to come.
type OrderEvents = (Vec<Event>, Option<(PointsStatus, u64)>);

fn order_events(view: &MemberOrderView, merchant: &AgentPubKey, now: Timestamp) -> ExternResult<OrderEvents> {
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
fn program_cited(order: &ActionHash) -> ExternResult<Option<RewardsProgram>> {
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(None) };
    let Some(rewards) = placed.rewards else { return Ok(None) };
    Ok(program_at(&rewards.program, &placed.catalog_ref)?.ok())
}

/// A member's standing at a store, worked out from what happened.
struct Standing {
    state: Option<PointsState>,
    /// What each order or grant moved, oldest first, by what it came from.
    log: Vec<(ActionHash, Event, i64)>,
    /// Orders whose points are on their way, oldest first.
    pending: Vec<OrderPoints>,
}

/// `grants`: each grant's record, when, and its points.
fn standing(catalog_ref: &ActionHash, customer: &AgentPubKey, merchant: &AgentPubKey, program: &RewardsProgram, orders: Vec<MemberOrderView>, grants: Vec<(ActionHash, Timestamp, u32)>) -> ExternResult<Standing> {
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

// --- the store's side ---

/// The store's own record of the orders a member placed under its program.
fn member_orders(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Vec<MemberOrderView>> {
    let types = [EntryType::try_from(UnitEntryTypes::MemberOrder)?];
    let mut out = Vec::new();
    for record in mine(&types).records()? {
        let Some(m) = decode_or::<MemberOrder>(&record).filter(|m| &m.customer == customer) else { continue };
        let Some(placed) = get(m.order.clone(), GetOptions::default())? else { continue };
        if OrderForRewards::of(&placed).is_some_and(|o| &o.catalog_ref == catalog_ref) {
            out.push(MemberOrderView { order: m.order, placed_at: placed.action().timestamp(), accepted: Some(m.accepted), reward: m.reward.map(|(id, ..)| id) });
        }
    }
    Ok(out)
}

/// The caller's store's own grants to `customer`, opened.
fn my_grants_to(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Vec<(ActionHash, Timestamp, GrantPayload)>> {
    let types = [EntryType::try_from(UnitEntryTypes::PointsGrant)?];
    let mut out = Vec::new();
    for record in mine(&types).records()? {
        let Some(grant) = decode_or::<PointsGrant>(&record).filter(|g| &g.to == customer) else { continue };
        if let Some(payload) = open::<GrantPayload>(customer, &grant.sealed)?.filter(|p| &p.catalog_ref == catalog_ref) {
            out.push((record.action_address().clone(), record.action().timestamp(), payload));
        }
    }
    Ok(out)
}

/// The caller's store's own program, current, and the store.
fn my_running_program(catalog_ref: &ActionHash) -> ExternResult<RewardsProgram> {
    let current = my_program(catalog_ref)?.ok_or(guest("This store has no rewards program."))?;
    decode_or::<RewardsProgram>(&current.record).ok_or(guest("that isn't a program"))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RedeemCheck {
    pub customer: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// The program version the order cites.
    pub program: ActionHash,
    pub reward: u16,
}

/// The store's check before accepting an order that spends a reward: the
/// customer's points, worked out from the store's own records, cover it at
/// the tier it needs. Errs with why not.
#[hdk_extern]
pub fn can_redeem(input: RedeemCheck) -> ExternResult<()> {
    let store_info = store(&input.catalog_ref)?;
    if store_info.owner != me()? {
        return Err(guest("not this store's owner"));
    }
    let program = my_running_program(&input.catalog_ref)?;
    let Ok(cited) = program_at(&input.program, &input.catalog_ref)? else { return Err(guest("This order's reward isn't one of your program's.")) };
    let reward = cited.reward(input.reward).ok_or(guest("This order's reward isn't one of your program's."))?;
    let orders = member_orders(&input.catalog_ref, &input.customer)?;
    let grants = my_grants_to(&input.catalog_ref, &input.customer)?.into_iter().map(|(grant, at, g)| (grant, at, g.points)).collect();
    let standing = standing(&input.catalog_ref, &input.customer, &store_info.owner, &program, orders, grants)?;
    let event = Event::Spend { at: sys_time()?, cost: u64::from(reward.cost), min_tier: reward.min_tier };
    step(&program, standing.state.as_ref(), event).map(|_| ()).map_err(|reason| {
        if reason == "that reward needs a higher tier" {
            guest("This customer's tier doesn't reach that reward, so this order can't be accepted -- decline it.")
        } else {
            guest("This customer's points don't cover that reward, so this order can't be accepted -- decline it.")
        }
    })
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MemberOrderInput {
    /// The order's original action.
    pub order: ActionHash,
    /// The caller's acceptance of it.
    pub accepted: ActionHash,
}

/// Records, privately, an order the caller's store accepted that joined its
/// program -- what its members' points are worked out from. Safe to repeat.
#[hdk_extern]
pub fn record_member_order(input: MemberOrderInput) -> ExternResult<()> {
    let Some(record) = get(input.order.clone(), GetOptions::default())? else { return Ok(()) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(()) };
    let Some(rewards) = placed.rewards.clone() else { return Ok(()) };
    if placed.merchant != me()? {
        return Ok(());
    }
    let types = [EntryType::try_from(UnitEntryTypes::MemberOrder)?];
    if mine(&types).any(|r| decode_or::<MemberOrder>(r).is_some_and(|m| m.order == input.order))? {
        return Ok(());
    }
    let reward = match rewards.reward {
        Some(id) => program_at(&rewards.program, &placed.catalog_ref)?.ok().and_then(|p| p.reward(id).map(|r| (id, r.cost, r.min_tier))),
        None => None,
    };
    create_entry(&EntryTypes::MemberOrder(MemberOrder { customer: placed.requester, order: input.order, accepted: input.accepted, reward }))?;
    Ok(())
}

/// A member's standing, as the caller's store works it out -- for its
/// member list.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MemberView {
    pub customer: AgentPubKey,
    pub balance: u64,
    pub tier: u8,
    pub orders: u32,
}

// --- grants ---

#[derive(Serialize, Deserialize, Debug)]
pub struct GrantInput {
    pub to: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub points: u32,
    pub note: String,
}

fn grant(to: AgentPubKey, catalog_ref: ActionHash, points: u32, reason: GrantReason) -> ExternResult<ActionHash> {
    if points == 0 || points > MAX_GRANT_POINTS {
        return Err(guest(format!("You can give between 1 and {MAX_GRANT_POINTS} points at a time.")));
    }
    let sealed = seal(&to, &GrantPayload { catalog_ref, points, reason })?;
    let hash = create_entry(&EntryTypes::PointsGrant(PointsGrant { to: to.clone(), sealed }))?;
    create_link(to, hash.clone(), LinkTypes::AgentToGrant, ())?;
    Ok(hash)
}

/// The caller's store giving a customer points -- an apology, a thank-you.
/// Sealed between the two.
#[hdk_extern]
pub fn grant_points(input: GrantInput) -> ExternResult<ActionHash> {
    if store(&input.catalog_ref)?.owner != me()? {
        return Err(guest("Only the store's owner can give its points."));
    }
    if input.note.chars().count() > MAX_GRANT_NOTE_CHARS {
        return Err(guest("Keep the note short."));
    }
    grant(input.to, input.catalog_ref, input.points, GrantReason::Goodwill { note: input.note })
}

/// Every grant to the caller, opened: from whom (the store's owner), when,
/// and what. Only the store that sealed it can have sent it.
fn grants_to_me() -> ExternResult<Vec<GrantToMe>> {
    let mut links = get_links(LinkQuery::try_new(me()?, LinkTypes::AgentToGrant)?, GetStrategy::default())?;
    links.sort_by_key(|l| std::cmp::Reverse(l.timestamp));
    let mut out = Vec::new();
    for link in links.into_iter().take(MAX_GRANTS_READ) {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash, GetOptions::default())? else { continue };
        let Some(grant) = decode_or::<PointsGrant>(&record) else { continue };
        let from = record.action().author().clone();
        if let Some(payload) = open::<GrantPayload>(&from, &grant.sealed)? {
            out.push(GrantToMe { grant: record.action_address().clone(), from, at: record.action().timestamp(), payload });
        }
    }
    Ok(out)
}

/// A grant to the caller, opened.
struct GrantToMe {
    grant: ActionHash,
    /// Who sealed it: only they could have.
    from: AgentPubKey,
    at: Timestamp,
    payload: GrantPayload,
}

/// How many of the newest grants to the caller are read: anyone can grant
/// to anyone, so a flood of them is read no further.
const MAX_GRANTS_READ: usize = 200;

/// A grant from a store the caller hasn't ordered from.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GiftOffer {
    pub grant: ActionHash,
    pub catalog_ref: ActionHash,
    pub store_name: String,
    pub points: u32,
    pub note: String,
    pub at: Timestamp,
}

/// Gifts from stores the caller hasn't ordered from -- shown apart, so a
/// stranger's points are theirs to take up (by ordering there) or ignore.
#[hdk_extern]
pub fn gift_offers(_: ()) -> ExternResult<Vec<GiftOffer>> {
    let mine_at: Vec<ActionHash> = my_orders()?.into_iter().map(|(_, catalog_ref, _)| catalog_ref).collect();
    let mut offers = Vec::new();
    for GrantToMe { grant, from, at, payload } in grants_to_me()? {
        if mine_at.contains(&payload.catalog_ref) {
            continue;
        }
        let Ok(store_info) = store(&payload.catalog_ref) else { continue };
        if store_info.owner != from {
            continue;
        }
        let note = match payload.reason {
            GrantReason::Goodwill { note } => note,
            GrantReason::Birthday { .. } => String::new(),
        };
        offers.push(GiftOffer { grant, catalog_ref: payload.catalog_ref, store_name: store_info.business_name, points: payload.points, note, at });
    }
    Ok(offers)
}

// --- the member's side ---

/// The caller's orders that joined a program, newest first: each one's
/// original action, its store, and when it was placed.
fn my_orders() -> ExternResult<Vec<(ActionHash, ActionHash, Timestamp)>> {
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
const MAX_ORDERS_READ: usize = 500;

/// The caller's view of one of their orders: whether, and when, the store
/// accepted it, and the reward it spent. An order the store never accepted
/// -- cancelled first, or declined -- spends nothing and earns nothing.
fn my_order_view(order: &ActionHash, placed_at: Timestamp) -> ExternResult<Option<(MemberOrderView, AgentPubKey)>> {
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(None) };
    let reward = placed.rewards.as_ref().and_then(|r| r.reward);
    let accepted = acceptance(order, &placed.merchant)?;
    Ok(Some((MemberOrderView { order: order.clone(), placed_at, accepted, reward }, placed.merchant)))
}

/// The store's acceptance of an order: its earliest update from `Placed`
/// that doesn't call it off (a decline is an update from `Placed` too).
fn acceptance(order: &ActionHash, merchant: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
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

fn card_for(catalog_ref: &ActionHash, orders: Vec<(ActionHash, Timestamp)>, grants: &[GrantToMe]) -> ExternResult<CardView> {
    let program = program_of(catalog_ref.clone())?;
    let store_info = store(catalog_ref)?;
    let me = me()?;
    let mut views = Vec::new();
    let mut reserved = 0u64;
    for (order, placed_at) in orders {
        let Some((view, _)) = my_order_view(&order, placed_at)? else { continue };
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
    let theirs: Vec<&GrantToMe> = grants.iter().filter(|g| g.from == store_info.owner && &g.payload.catalog_ref == catalog_ref).collect();
    let Some(view) = program.clone() else {
        return Ok(CardView { catalog_ref: catalog_ref.clone(), store_name: store_info.business_name, program, state: None, balance: 0, reserved, tier: 0, expires_at: None, pending: Vec::new(), pending_points: 0, history: Vec::new() });
    };
    let grants: Vec<(ActionHash, Timestamp, u32)> = theirs.iter().map(|g| (g.grant.clone(), g.at, g.payload.points)).collect();
    let standing = standing(catalog_ref, &me, &store_info.owner, &view.program, views, grants)?;
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

const HISTORY: usize = 30;

/// Whether an order was called off: any of its versions cancels it.
fn order_called_off(order: &ActionHash) -> ExternResult<bool> {
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
    card_for(&catalog_ref, orders, &grants_to_me()?)
}

/// Every card the caller holds: a store they've ordered from under its
/// program. Most recent first.
#[hdk_extern]
pub fn my_cards(_: ()) -> ExternResult<Vec<CardView>> {
    let grants = grants_to_me()?;
    let mut stores: Vec<(ActionHash, Vec<(ActionHash, Timestamp)>)> = Vec::new();
    for (order, catalog_ref, at) in my_orders()? {
        match stores.iter_mut().find(|(s, _)| s == &catalog_ref) {
            Some((_, list)) => list.push((order, at)),
            None => stores.push((catalog_ref, vec![(order, at)])),
        }
    }
    stores.into_iter().map(|(store, orders)| card_for(&store, orders, &grants)).collect()
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
    let Some((view, merchant)) = my_order_view(&order, record.action().timestamp())? else { return Ok(None) };
    if view.accepted.is_none() {
        return Ok(None);
    }
    let (_, status) = order_events(&view, &merchant, sys_time()?)?;
    let Some((status, base)) = status else { return Ok(None) };
    // What it earns at the member's standing without it.
    let card = card_for(&placed.catalog_ref, my_orders()?.into_iter().filter(|(o, c, _)| c == &placed.catalog_ref && o != &order).map(|(o, _, at)| (o, at)).collect(), &grants_to_me()?)?;
    let mut rules = program.program.clone();
    if !may_be_welcomed(&placed.requester)? {
        rules.earn.welcome_bonus = 0;
    }
    let points = step(&rules, card.state.as_ref(), Event::Earn { at: sys_time()?, base }).map_or(base, |(_, p)| p);
    Ok(Some(OrderPoints { order, catalog_ref: placed.catalog_ref, placed_at: record.action().timestamp(), points, status }))
}

// --- birthdays ---

/// The caller's birth month, once set -- kept on this device only.
#[hdk_extern]
pub fn my_birth_month(_: ()) -> ExternResult<Option<u8>> {
    let types = [EntryType::try_from(UnitEntryTypes::BirthMonth)?];
    Ok(mine(&types).latest()?.and_then(|r| decode_or::<BirthMonth>(&r)).map(|b| b.month))
}

/// Sets the caller's birth month, once, on this device -- then tells each
/// store they order from, sealed so only that store can read it.
#[hdk_extern]
pub fn set_birth_month(month: u8) -> ExternResult<()> {
    if my_birth_month(())?.is_some() {
        return Err(guest("Your birthday month is already set."));
    }
    if !(1..=12).contains(&month) {
        return Err(guest("Choose a month."));
    }
    create_entry(&EntryTypes::BirthMonth(BirthMonth { month }))?;
    share_birthdays(())?;
    Ok(())
}

/// Tells each store the caller orders from their birth month, sealed to it,
/// if it hasn't been told. Returns how many it told.
#[hdk_extern]
pub fn share_birthdays(_: ()) -> ExternResult<u32> {
    let Some(month) = my_birth_month(())? else { return Ok(0) };
    let types = [EntryType::try_from(UnitEntryTypes::BirthdayShare)?];
    let told: Vec<ActionHash> = mine(&types).records()?.iter().filter_map(decode_or::<BirthdayShare>).map(|b| b.catalog_ref).collect();
    let mut stores: Vec<ActionHash> = my_orders()?.into_iter().map(|(_, c, _)| c).collect();
    stores.sort();
    stores.dedup();
    let mut count = 0;
    for catalog_ref in stores.into_iter().filter(|c| !told.contains(c)) {
        let Ok(store_info) = store(&catalog_ref) else { continue };
        let sealed_month = seal(&store_info.owner, &month)?;
        let hash = create_entry(&EntryTypes::BirthdayShare(BirthdayShare { catalog_ref: catalog_ref.clone(), sealed_month }))?;
        create_link(catalog_ref, hash, LinkTypes::CatalogToBirthday, ())?;
        count += 1;
    }
    Ok(count)
}

/// How long a member must have ordered at a store before it celebrates
/// them: a fresh account set up for the birthday alone gets nothing.
const BIRTHDAY_AFTER_DAYS: i64 = 30;

/// The caller's stores giving their birthday points to members whose month
/// it is: once a year each, to members who've ordered there for a while,
/// taking the first month each member told it. Returns how many it gave.
#[hdk_extern]
pub fn celebrate_birthdays(_: ()) -> ExternResult<u32> {
    let types = [EntryType::try_from(UnitEntryTypes::RewardsProgram)?];
    let now = sys_time()?;
    let mut given = 0;
    for original in mine(&types).creates().records()? {
        let Some(first) = decode_or::<RewardsProgram>(&original) else { continue };
        let Ok(program) = my_running_program(&first.catalog_ref) else { continue };
        if !program.active || program.birthday_points == 0 {
            continue;
        }
        let local = local_time(now, &program.time_zone);
        let member_types = [EntryType::try_from(UnitEntryTypes::MemberOrder)?];
        let members: Vec<(AgentPubKey, Timestamp)> = mine(&member_types).records()?.iter().filter_map(|r| decode_or::<MemberOrder>(r).map(|m| (m.customer, r.action().timestamp()))).collect();
        let mut links = get_links(LinkQuery::try_new(program.catalog_ref.clone(), LinkTypes::CatalogToBirthday)?, GetStrategy::default())?;
        links.sort_by_key(|l| l.timestamp);
        let mut seen: Vec<AgentPubKey> = Vec::new();
        for link in links {
            let member = link.author.clone();
            if seen.contains(&member) {
                continue;
            }
            seen.push(member.clone());
            let first_order = members.iter().filter(|(c, _)| c == &member).map(|(_, at)| *at).min();
            if !first_order.is_some_and(|at| now.as_micros() - at.as_micros() >= BIRTHDAY_AFTER_DAYS * 86_400_000_000) {
                continue;
            }
            let Some(share) = link.target.into_action_hash().and_then(|h| get(h, GetOptions::default()).ok().flatten()).and_then(|r| decode_or::<BirthdayShare>(&r)) else { continue };
            let Some(month) = open::<u8>(&member, &share.sealed_month)? else { continue };
            if month != local.month {
                continue;
            }
            let celebrated = my_grants_to(&program.catalog_ref, &member)?.iter().any(|(_, _, g)| matches!(g.reason, GrantReason::Birthday { year } if year == local.year));
            if celebrated {
                continue;
            }
            if handshake_coordinator_support::isolated::<_, ActionHash>("grant_birthday", BirthdayInput { to: member, catalog_ref: program.catalog_ref.clone(), points: program.birthday_points, year: local.year }).is_some() {
                given += 1;
            }
        }
    }
    Ok(given)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BirthdayInput {
    pub to: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub points: u32,
    pub year: i32,
}

/// One birthday grant (`celebrate_birthdays`).
#[hdk_extern]
pub fn grant_birthday(input: BirthdayInput) -> ExternResult<ActionHash> {
    if store(&input.catalog_ref)?.owner != me()? {
        return Err(guest("not this store's owner"));
    }
    grant(input.to, input.catalog_ref, input.points, GrantReason::Birthday { year: input.year })
}

/// Celebrates birthdays and tells new stores a member's month, a few times
/// a day, whether or not the app is open. Scheduled at `init`.
#[hdk_extern(infallible)]
pub fn rewards_periodically(_: Option<Schedule>) -> Option<Schedule> {
    let _ = celebrate_birthdays(());
    let _ = share_birthdays(());
    Some(Schedule::Persisted("0 7 */3 * * * *".into()))
}

#[hdk_extern]
pub fn init() -> ExternResult<InitCallbackResult> {
    prepare_device(())?;
    Ok(InitCallbackResult::Pass)
}

/// This device's background work, set up if it isn't (see dispatch's
/// `prepare_device`).
#[hdk_extern]
pub fn prepare_device(_: ()) -> ExternResult<()> {
    schedule("rewards_periodically")?;
    Ok(())
}

// --- a store's view ---

/// How a store's program is doing, from its own private records.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ProgramStats {
    /// Members who've ordered under it.
    pub members: u32,
    /// Of them, those who ordered in the last 30 days.
    pub active_members: u32,
    /// Orders placed under it.
    pub orders: u32,
    /// Rewards redeemed.
    pub redemptions: u32,
}

#[hdk_extern]
pub fn program_stats(catalog_ref: ActionHash) -> ExternResult<ProgramStats> {
    let now = sys_time()?.as_micros();
    let types = [EntryType::try_from(UnitEntryTypes::MemberOrder)?];
    let mut members: Vec<(AgentPubKey, bool)> = Vec::new();
    let mut stats = ProgramStats::default();
    for record in mine(&types).records()? {
        let Some(m) = decode_or::<MemberOrder>(&record) else { continue };
        let ours = get(m.order.clone(), GetOptions::local())?.and_then(|r| OrderForRewards::of(&r)).is_some_and(|o| o.catalog_ref == catalog_ref);
        if !ours {
            continue;
        }
        stats.orders += 1;
        stats.redemptions += u32::from(m.reward.is_some());
        let recent = now - record.action().timestamp().as_micros() <= 30 * 86_400_000_000;
        match members.iter_mut().find(|(c, _)| c == &m.customer) {
            Some((_, active)) => *active |= recent,
            None => members.push((m.customer, recent)),
        }
    }
    stats.members = members.len() as u32;
    stats.active_members = members.iter().filter(|(_, a)| *a).count() as u32;
    Ok(stats)
}

#[cfg(feature = "test-utils")]
mod test_utils {
    use super::*;

    /// Writes a program exactly as given -- a forgery a modified app would
    /// try, for validation tests.
    #[hdk_extern]
    pub fn create_raw_program_for_testing(program: RewardsProgram) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::RewardsProgram(program))
    }

    /// A grant sealed by the caller, about any store -- what a stranger
    /// pretending to be a store would write.
    #[hdk_extern]
    pub fn create_raw_points_grant_for_testing(input: GrantInput) -> ExternResult<ActionHash> {
        let sealed = seal(&input.to, &GrantPayload { catalog_ref: input.catalog_ref, points: input.points, reason: GrantReason::Goodwill { note: input.note } })?;
        let hash = create_entry(&EntryTypes::PointsGrant(PointsGrant { to: input.to.clone(), sealed }))?;
        create_link(input.to, hash.clone(), LinkTypes::AgentToGrant, ())?;
        Ok(hash)
    }

    handshake_coordinator_support::raw_link_test_externs!(CatalogToProgram, AgentToGrant, CatalogToBirthday);
}
