//! Each member's points at a store as a running total
//! (`rewards_integrity::ledger`), kept privately by the side that reads them:
//! the store's account of each member, and each member's of every store
//! they belong to. A card, or the store's check before it honours a reward,
//! plays only what's still open on top of it -- never the member's whole
//! history, however long -- and an account's latest version is found by
//! looking up its markers' hashes (`KeptVersion`), never by walking the
//! chain (docs/REWARDS.md, "Accounts").
//!
//! An account is only ever what the records say, folded: it's played
//! afresh from them the first time, when the store changes its program, or
//! when something turns up from before what's folded. Writes that carry it
//! forward happen where the records change -- the store accepting an
//! order, giving points, a member placing one -- in the same call, so
//! nothing they record can be lost to a race; a read that folds something
//! keeps it only if no version has been written since it read it.

use super::*;
use rewards_integrity::ledger::{fold, Folded, GrantKind, OpenGrant, OpenOrder, OrderFacts, Settled};

/// How many lines of history an account keeps: what a card shows.
pub(crate) const HISTORY: usize = 30;

/// A record the caller keeps privately, at its latest version: which
/// version that is (0: none yet), and what it says.
pub(crate) struct Kept<T> {
    pub(crate) n: u32,
    pub(crate) value: Option<T>,
}

/// The caller's marker of `record`'s `n`th version, if they wrote one.
fn marker(record: &KeptRecord, n: u32) -> ExternResult<Option<ActionHash>> {
    let me = me()?;
    let entry = EntryTypes::KeptVersion(KeptVersion { record: record.clone(), n });
    Ok(match get_details(hash_entry(&entry)?, GetOptions::local())? {
        Some(Details::Entry(details)) => details.actions.iter().find(|a| a.action().author() == &me).map(|a| a.hashed.hash.clone()),
        _ => None,
    })
}

/// `record` at its latest version: the highest `n` with a marker, found by
/// doubling, then halving between -- a few lookups, however many versions.
pub(crate) fn kept<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &KeptRecord) -> ExternResult<Kept<T>> {
    let Some(mut found) = marker(record, 1)? else { return Ok(Kept { n: 0, value: None }) };
    let (mut low, mut high) = (1u32, 2u32);
    while let Some(at) = marker(record, high)? {
        (low, found) = (high, at);
        if high == u32::MAX {
            break;
        }
        high = high.saturating_mul(2);
    }
    // `low` is marked; `high` isn't (or `low` is as far as versions go).
    while high - low > 1 {
        let mid = low + (high - low) / 2;
        match marker(record, mid)? {
            Some(at) => (low, found) = (mid, at),
            None => high = mid,
        }
    }
    // The version is the action just before its marker.
    let version = get(found, GetOptions::local())?.and_then(|m| m.action().prev_action().cloned());
    let value = match version {
        Some(version) => get(version, GetOptions::local())?.and_then(|r| decode_or::<T>(&r)),
        None => None,
    };
    Ok(Kept { n: low, value })
}

/// Writes `entry` as `record`'s version after `n`, and its marker straight
/// after it, so the marker's previous action is the version.
pub(crate) fn write_kept(record: KeptRecord, n: u32, entry: &EntryTypes) -> ExternResult<()> {
    create_entry(entry)?;
    create_entry(&EntryTypes::KeptVersion(KeptVersion { record, n: n + 1 }))?;
    Ok(())
}

fn account_record(catalog_ref: &ActionHash, member: &AgentPubKey, kept_by_store: bool) -> KeptRecord {
    KeptRecord::Account { catalog_ref: catalog_ref.clone(), member: member.clone(), kept_by_store }
}

/// The account of `member` at `catalog_ref` the caller keeps: the store's
/// of a member (`kept_by_store`), or a member's own.
pub(crate) fn account(catalog_ref: &ActionHash, member: &AgentPubKey, kept_by_store: bool) -> ExternResult<Kept<MemberAccount>> {
    kept(&account_record(catalog_ref, member, kept_by_store))
}

/// Writes `next` as the account's version after `found`'s.
pub(crate) fn keep(found: &Kept<MemberAccount>, next: MemberAccount) -> ExternResult<()> {
    write_kept(account_record(&next.catalog_ref, &next.member, next.kept_by_store), found.n, &EntryTypes::MemberAccount(next))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct KeepInput {
    pub account: MemberAccount,
    /// The version the caller folded from: kept only if it's still the
    /// latest, so a read never writes over what changed meanwhile.
    pub based_on: u32,
}

/// Keeps what a read folded, in a call of its own (`isolated`): a read
/// never fails for it, and a race with a write only means the next read
/// folds again.
#[hdk_extern]
pub fn keep_account_read(input: KeepInput) -> ExternResult<bool> {
    let found = account(&input.account.catalog_ref, &input.account.member, input.account.kept_by_store)?;
    if found.n != input.based_on {
        return Ok(false);
    }
    keep(&found, input.account)?;
    Ok(true)
}

/// What a read folded, kept if it moved anything -- best effort.
pub(crate) fn keep_read(found: &Kept<MemberAccount>, next: MemberAccount, folded: &Folded) {
    if folded.moved {
        let _ = isolated::<_, bool>("keep_account_read", KeepInput { account: next, based_on: found.n });
    }
}

/// An open order as it stands now -- for `fold`, and what its earning is
/// waiting on.
pub(crate) fn facts(order: &OpenOrder, learn_acceptance: bool, now: Timestamp) -> ExternResult<(OrderFacts, OrderNow)> {
    // The member's side learns the store accepted from the network -- by the
    // order's own store owner, whichever key holds the store now; the
    // store's knew when it did.
    let accepted = match &order.accepted {
        Some(accepted) => Some(accepted.clone()),
        None if learn_acceptance => acceptance_by_its_store(&order.order)?,
        None => None,
    };
    // Settled before, and still unappealed: what's left is its refund
    // period ending -- one read, not the order's whole story again; none,
    // once its window has closed for good.
    if let Some(settled) = &order.settled {
        if settled.closed || dispatch::<_, Option<AppealWire>>("get_appeal_for_order", order.order.clone())?.is_none() {
            let settled = &Settled { closed: settled.closed || settled.closes(now), ..settled.clone() };
            let mut events: Vec<Event> = settled.spend.iter().map(|(at, cost, min_tier)| Event::Spend { at: *at, cost: *cost, min_tier: *min_tier }).collect();
            let ended = settled.ended(now);
            let status = if ended {
                events.push(Event::Earn { at: settled.settled_at, base: settled.base });
                PointsStatus::Earned
            } else {
                PointsStatus::RefundPeriod { until: settled.available_at }
            };
            let now_ = OrderNow { events, pending: Some((status, settled.base)), done: ended, settled: Some(settled.clone()) };
            return Ok((OrderFacts { order: OpenOrder { accepted, settled: Some(settled.clone()), ..order.clone() }, events: now_.events.clone(), done: now_.done }, now_));
        }
    }
    let view = MemberOrderView { order: order.order.clone(), placed_at: order.placed_at, accepted: accepted.clone(), reward: order.reward };
    let now_ = order_now(&view, now)?;
    let open = OpenOrder { accepted, settled: now_.settled.clone(), ..order.clone() };
    Ok((OrderFacts { order: open, events: now_.events.clone(), done: now_.done }, now_))
}

/// A ledger carried forward, and each order's standing now -- or why it has
/// to be played afresh from everything.
pub(crate) type Played = Result<(Folded, Vec<(OrderFacts, OrderNow)>), rewards_integrity::ledger::Rebuild>;

/// `orders` and `grants` played onto `prior` (`None`: from nothing).
pub(crate) fn play(
    program: &ProgramView,
    prior: Option<&rewards_integrity::ledger::Ledger>,
    orders: &[OpenOrder],
    grants: Vec<OpenGrant>,
    learn_acceptance: bool,
    now: Timestamp,
) -> ExternResult<Played> {
    let mut seen: Vec<&ActionHash> = Vec::new();
    let mut standing = Vec::new();
    for order in orders {
        if seen.contains(&&order.order) {
            continue;
        }
        seen.push(&order.order);
        standing.push(facts(order, learn_acceptance, now)?);
    }
    let facts = standing.iter().map(|(f, _)| f.clone()).collect();
    Ok(fold(&program.program, &program.version, prior, facts, grants, now, HISTORY).map(|folded| (folded, standing)))
}

/// A grant, as a ledger plays it.
pub(crate) fn open_grant(grant: ActionHash, at: Timestamp, payload: &GrantPayload) -> OpenGrant {
    let kind = match &payload.reason {
        GrantReason::Birthday { .. } => GrantKind::Birthday,
        GrantReason::Goodwill { note } => GrantKind::Gift { note: (!note.is_empty()).then(|| note.clone()) },
        GrantReason::Carried { .. } => GrantKind::Carried,
    };
    OpenGrant { grant, at, points: payload.points, kind }
}

// --- a member's list of their accounts ---

fn stores_record(member: &AgentPubKey) -> KeptRecord {
    KeptRecord::Stores { member: member.clone() }
}

/// The stores the caller keeps an account at, newest first -- `None` if
/// they've never kept the list (accounts from before it, which a full read
/// of their orders finds).
pub(crate) fn my_stores() -> ExternResult<Option<Vec<ActionHash>>> {
    let list = kept::<MemberStores>(&stores_record(&me()?))?;
    Ok((list.n > 0).then(|| list.value.map(|l| l.stores).unwrap_or_default()))
}

/// Adds `stores` to the caller's list, newest first, if any are new.
pub(crate) fn add_my_stores(stores: &[ActionHash]) -> ExternResult<()> {
    let me = me()?;
    let list = kept::<MemberStores>(&stores_record(&me))?;
    let mut kept_stores = list.value.map(|l| l.stores).unwrap_or_default();
    let new: Vec<ActionHash> = stores.iter().filter(|s| !kept_stores.contains(s)).cloned().collect();
    if new.is_empty() && list.n > 0 {
        return Ok(());
    }
    kept_stores.splice(0..0, new);
    write_kept(stores_record(&me), list.n, &EntryTypes::MemberStores(MemberStores { member: me, stores: kept_stores }))
}

/// Keeps the caller's list of stores, in a call of its own -- for a read
/// that found it missing.
#[hdk_extern]
pub fn keep_my_stores_read(stores: Vec<ActionHash>) -> ExternResult<()> {
    add_my_stores(&stores)
}
