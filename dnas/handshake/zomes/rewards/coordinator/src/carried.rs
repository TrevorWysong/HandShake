//! A store's rewards carried with it when its owner republishes it: after
//! recovering their account on a new key (`catalog::move_store`), or onto a
//! new network (`catalog::import_store`). See docs/REWARDS.md, "When a
//! store moves".
//!
//! - **The program** is copied to the new store, naming the copies of its
//!   items and choice groups (`carry_program`).
//! - **Members' points, on the same network**, carry on by themselves: the
//!   new store plays a member's history across its whole line of stores
//!   (`store::member_orders`). Gifts an earlier key gave are sealed to that
//!   key, so the member shows them to the store's owner now
//!   (`reveal_my_gifts`), and each is counted -- by the store and the
//!   member's card alike -- once it's proven against its grant's public
//!   commitment (`earlier_gifts`).
//! - **Members' points, on a new network**, are carried over as a grant
//!   (`carry_previous_points`): the old network works out what the member
//!   held there, from its public records and the gifts the member shows,
//!   asked by the store's owner or the key the owner moved to. The member's
//!   old key seals its gifts to its new key as it leaves (`carry_my_gifts`).

use super::*;
use handshake_coordinator_support::{call_role, open_chunked, seal_chunked};
use rewards_integrity::ledger::OpenGrant;
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Debug)]
pub struct CarryProgramInput {
    pub from: ActionHash,
    pub to: ActionHash,
    /// Whether `from` is on the network before this one.
    pub previous: bool,
    /// Each copied item and choice group: its original, then its copy.
    pub items: Vec<(ActionHash, ActionHash)>,
    pub groups: Vec<(ActionHash, ActionHash)>,
}

/// Copies `from`'s program to the caller's store `to`, naming the copies of
/// what it names. Safe to repeat: a store with a program keeps it.
#[hdk_extern]
pub fn carry_program(input: CarryProgramInput) -> ExternResult<()> {
    if store(&input.to)?.owner != me()? {
        return Err(guest("Only the store's owner carries its program."));
    }
    if program_of(input.to.clone())?.is_some() {
        return Ok(());
    }
    let old: Option<ProgramView> = if input.previous {
        call_role("previous", "rewards", "program_of", input.from.clone())?.map_err(|why| guest(format!("couldn't read the store's program on the previous network: {why}")))?
    } else {
        program_of(input.from.clone())?
    };
    let Some(old) = old else { return Ok(()) };
    let items: BTreeMap<ActionHash, ActionHash> = input.items.into_iter().collect();
    let groups: BTreeMap<ActionHash, ActionHash> = input.groups.into_iter().collect();
    save_program(old.program.remapped(input.to, |item| items.get(item).cloned(), |group| groups.get(group).cloned()))?;
    Ok(())
}

/// `items` in as few lists as fit an entry each (`MAX_GIFT_LIST_BYTES`,
/// encoded): however many there are, none is left out.
fn in_entries<T: Serialize + std::fmt::Debug + Clone>(items: &[T]) -> ExternResult<Vec<Vec<T>>> {
    let mut lists: Vec<Vec<T>> = Vec::new();
    let mut weight = 0;
    for item in items {
        let size = ExternIO::encode(item).map_err(|e| wasm_error!(e))?.0.len();
        if lists.is_empty() || weight + size > MAX_GIFT_LIST_BYTES {
            lists.push(Vec::new());
            weight = 0;
        }
        weight += size;
        lists.last_mut().expect("just pushed").push(item.clone());
    }
    Ok(lists)
}

// --- gifts shown to a store they weren't sealed to ---

/// `member`'s reveal links at the store `catalog_ref`, written by them.
fn reveal_links(catalog_ref: &ActionHash, member: &AgentPubKey) -> ExternResult<Vec<Link>> {
    let query = LinkQuery::try_new(catalog_ref.clone(), LinkTypes::StoreToReveal)?.author(member.clone()).tag_prefix(LinkTag::new(member.get_raw_39().to_vec()));
    Ok(get_links(query, GetStrategy::default())?.into_iter().filter(|link| &link.author == member && link.tag.0 == member.get_raw_39()).collect())
}

/// The grants `member` has shown the store `catalog_ref`, opened by the
/// caller -- its owner, or the member themselves. Each once.
fn revealed(catalog_ref: &ActionHash, member: &AgentPubKey) -> ExternResult<Vec<RevealedGrant>> {
    let me = me()?;
    let owner = store(catalog_ref)?.owner;
    let counterpart = match (&me == member, me == owner) {
        (true, _) => owner,
        (_, true) => member.clone(),
        _ => return Ok(Vec::new()),
    };
    let mut out: Vec<RevealedGrant> = Vec::new();
    for link in reveal_links(catalog_ref, member)? {
        let Some(record) = link.target.into_action_hash().map(|hash| get(hash, GetOptions::default())).transpose()?.flatten() else { continue };
        let Some(reveal) = decode_or::<GiftReveal>(&record).filter(|r| &r.catalog_ref == catalog_ref && record.action().author() == member) else { continue };
        for grant in open_chunked::<Vec<RevealedGrant>>(&counterpart, &reveal.sealed)?.unwrap_or_default() {
            if !out.iter().any(|g| g.grant == grant.grant) {
                out.push(grant);
            }
        }
    }
    Ok(out)
}

/// `shown`, if it's a grant to `member` from one of `stores`, by that
/// store's owner, saying what it's shown to say: as a ledger plays it,
/// dated by its own record.
fn proven(shown: &RevealedGrant, member: &AgentPubKey, stores: &[ActionHash]) -> ExternResult<Option<OpenGrant>> {
    let Some(record) = get(shown.grant.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(grant) = decode_or::<PointsGrant>(&record) else { return Ok(None) };
    if &grant.to != member || !stores.contains(&grant.catalog_ref) || !shown.proves(&grant) || &store(&grant.catalog_ref)?.owner != record.action().author() {
        return Ok(None);
    }
    Ok(Some(open_grant(record.action_address().clone(), record.action().timestamp(), &shown.payload)))
}

/// The gifts earlier keys of the store `catalog_ref` gave `member` that
/// they've shown it, each proven -- counted alike by the store and by the
/// member's card.
pub(crate) fn earlier_gifts(catalog_ref: &ActionHash, member: &AgentPubKey) -> ExternResult<Vec<OpenGrant>> {
    let earlier: Vec<ActionHash> = store_line(catalog_ref)?.into_iter().skip(1).collect();
    if earlier.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for shown in revealed(catalog_ref, member)? {
        out.extend(proven(&shown, member, &earlier)?);
    }
    Ok(out)
}

/// The caller's key on the previous network, and the store `catalog_ref`
/// was brought over from there -- if both moved.
fn came_over(catalog_ref: &ActionHash, member: &AgentPubKey) -> ExternResult<Option<(ActionHash, AgentPubKey)>> {
    let from: Option<ActionHash> = call_local("catalog", "imported_from", catalog_ref.clone())?.map_err(|why| guest(format!("imported_from: {why}")))?;
    let Some(from) = from else { return Ok(None) };
    let before: Option<AgentPubKey> = call_local("account", "arrived_from", member.clone())?.map_err(|why| guest(format!("arrived_from: {why}")))?;
    Ok(before.map(|before| (from, before)))
}

/// Shows the owner of the store `catalog_ref` every grant the caller was
/// given by an earlier key of it, or by the store it came from on the
/// network before: once, as they first order or open their card there.
/// The keys that gave them are gone, or their network closed, so there's
/// never more to show after. A store with no past shows nothing. How many
/// it showed.
#[hdk_extern]
pub fn reveal_my_gifts(catalog_ref: ActionHash) -> ExternResult<u32> {
    let me = me()?;
    let owner = store(&catalog_ref)?.owner;
    if owner == me || !reveal_links(&catalog_ref, &me)?.is_empty() {
        return Ok(0);
    }
    let earlier: Vec<ActionHash> = store_line(&catalog_ref)?.into_iter().skip(1).collect();
    let came = came_over(&catalog_ref, &me)?;
    if earlier.is_empty() && came.is_none() {
        return Ok(0);
    }
    let mut gifts: Vec<RevealedGrant> = Vec::new();
    for store_before in earlier {
        let owner_before = store(&store_before)?.owner;
        if owner_before != owner {
            gifts.extend(grants_from(&owner_before, &store_before, &[])?.into_iter().map(|g| RevealedGrant { grant: g.grant, payload: g.payload }));
        }
    }
    if let Some((from, before)) = came {
        let line: Vec<ActionHash> = call_role("previous", "rewards", "store_line_of", from)?.map_err(|why| guest(format!("couldn't read the previous network: {why}")))?;
        let carried: Vec<CarriedGift> = call_role("previous", "rewards", "carried_gifts_of", before)?.map_err(|why| guest(format!("couldn't read the previous network: {why}")))?;
        gifts.extend(carried.into_iter().filter(|g| line.contains(&g.catalog_ref)).map(|g| g.revealed));
    }
    // Written even with nothing in it: the store has been shown all there is.
    let lists = match in_entries(&gifts)? {
        lists if lists.is_empty() => vec![Vec::new()],
        lists => lists,
    };
    for list in lists {
        let hash = create_entry(&EntryTypes::GiftReveal(GiftReveal { catalog_ref: catalog_ref.clone(), sealed: seal_chunked(&owner, &list)? }))?;
        create_link(catalog_ref.clone(), hash, LinkTypes::StoreToReveal, LinkTag::new(me.get_raw_39().to_vec()))?;
    }
    Ok(u32::try_from(gifts.len()).unwrap_or(u32::MAX))
}

/// The store `catalog_ref` and every store it carries on from, here --
/// asked by the next network, through its `previous` role.
#[hdk_extern]
pub fn store_line_of(catalog_ref: ActionHash) -> ExternResult<Vec<ActionHash>> {
    store_line(&catalog_ref)
}

// --- leaving for the next network ---

/// Seals every grant the caller was given, opened, to `successor` -- their
/// key on the next network -- as their account leaves this one (account's
/// `migrate_out`): the stores that come over can be shown them there.
#[hdk_extern]
pub fn carry_my_gifts(successor: AgentPubKey) -> ExternResult<()> {
    let me = me()?;
    let mut gifts: Vec<CarriedGift> = Vec::new();
    for link in get_links(LinkQuery::try_new(me.clone(), LinkTypes::AgentToGrant)?, GetStrategy::default())? {
        let Some(record) = link.target.into_action_hash().map(|hash| get(hash, GetOptions::default())).transpose()?.flatten() else { continue };
        let Some(grant) = decode_or::<PointsGrant>(&record).filter(|g| g.to == me) else { continue };
        let giver = record.action().author();
        if gifts.iter().any(|g| &g.revealed.grant == record.action_address()) {
            continue;
        }
        if let Some(payload) = open::<GrantPayload>(giver, &grant.sealed)? {
            gifts.push(CarriedGift { catalog_ref: grant.catalog_ref, revealed: RevealedGrant { grant: record.action_address().clone(), payload } });
        }
    }
    for list in in_entries(&gifts)? {
        let hash = create_entry(&EntryTypes::CarriedGifts(CarriedGifts { sealed: seal_chunked(&successor, &list)? }))?;
        create_link(me.clone(), hash, LinkTypes::MemberToCarriedGifts, ())?;
    }
    Ok(())
}

/// The gifts `account` carried to the caller -- its key on the next
/// network, reading here through its `previous` role. None for anyone
/// else: they're sealed to that key.
#[hdk_extern]
pub fn carried_gifts_of(account: AgentPubKey) -> ExternResult<Vec<CarriedGift>> {
    let query = LinkQuery::try_new(account.clone(), LinkTypes::MemberToCarriedGifts)?.author(account.clone());
    let mut out: Vec<CarriedGift> = Vec::new();
    for link in get_links(query, GetStrategy::default())?.into_iter().filter(|link| link.author == account) {
        let Some(record) = link.target.into_action_hash().map(|hash| get(hash, GetOptions::default())).transpose()?.flatten() else { continue };
        let Some(carried) = decode_or::<CarriedGifts>(&record).filter(|_| record.action().author() == &account) else { continue };
        for gift in open_chunked::<Vec<CarriedGift>>(&account, &carried.sealed)?.unwrap_or_default() {
            if !out.iter().any(|g| g.revealed.grant == gift.revealed.grant) {
                out.push(gift);
            }
        }
    }
    Ok(out)
}

// --- arriving on the next network ---

#[derive(Serialize, Deserialize, Debug)]
pub struct CarriedBalanceInput {
    pub catalog_ref: ActionHash,
    pub member: AgentPubKey,
    /// The grants the member has shown the store that came over.
    pub gifts: Vec<RevealedGrant>,
}

/// Whether the account `owner` moved to the caller's key, on to the next
/// network, and closed its chain behind it.
fn moved_to_me(owner: &AgentPubKey) -> ExternResult<bool> {
    #[derive(Deserialize, Debug)]
    struct Moved {
        account: AgentPubKey,
        close: Option<ActionHash>,
    }
    let moved: Vec<Moved> = call_local("account", "migrations_to_me", ())?.map_err(|why| guest(format!("migrations_to_me: {why}")))?;
    Ok(moved.iter().any(|m| &m.account == owner && m.close.is_some()))
}

/// What `member` holds at the store `catalog_ref` now, played from the
/// public records -- their orders there and at the stores it carries on
/// from, and the gifts they've shown, each proven -- asked through the
/// next network's `previous` role by the store's owner, or the key they
/// moved to. The caller's own grants count too, if it's the owner.
#[hdk_extern]
pub fn carried_balance(input: CarriedBalanceInput) -> ExternResult<u64> {
    let owner = store(&input.catalog_ref)?.owner;
    let me = me()?;
    if owner != me && !moved_to_me(&owner)? {
        return Err(guest("Only the store's owner, or the key they moved it to, works out its members' points."));
    }
    let Some(program) = program_of(input.catalog_ref.clone())? else { return Ok(0) };
    let line = store_line(&input.catalog_ref)?;
    let mut grants: Vec<OpenGrant> = if owner == me { my_grants_to(&input.catalog_ref, &input.member)? } else { Vec::new() };
    for shown in &input.gifts {
        if let Some(grant) = proven(shown, &input.member, &line)?.filter(|g| !grants.iter().any(|kept| kept.grant == g.grant)) {
            grants.push(grant);
        }
    }
    let orders = member_orders(&input.catalog_ref, &input.member)?;
    let played = play(&program, None, &orders, grants, false, sys_time()?)?.map_err(|_| guest("couldn't play this member's history"))?;
    Ok(played.0.state.map_or(0, |state| state.balance))
}

/// How many grants `member` has shown the store `catalog_ref` -- by the
/// reveals they've written, read without opening any.
pub(crate) fn reveals_shown(catalog_ref: &ActionHash, member: &AgentPubKey) -> ExternResult<u32> {
    Ok(u32::try_from(reveal_links(catalog_ref, member)?.len()).unwrap_or(u32::MAX))
}

/// What `member` held at the store the caller's `catalog_ref` was brought
/// over from, less what's been carried already, granted to them here
/// citing `order`. `Ok(None)`: nothing more to carry (the store or the
/// member didn't come over, or there's nothing left). `Err`: the previous
/// network couldn't say just now -- tried again on their next order.
pub(crate) fn carry_previous_points(catalog_ref: &ActionHash, member: &AgentPubKey, order: &ActionHash) -> ExternResult<Option<OpenGrant>> {
    let Some((from, before)) = came_over(catalog_ref, member)? else { return Ok(None) };
    let gifts = revealed(catalog_ref, member)?;
    let held: u64 = call_role("previous", "rewards", "carried_balance", CarriedBalanceInput { catalog_ref: from.clone(), member: before, gifts })?.map_err(|why| guest(format!("couldn't read the previous network: {why}")))?;
    let carried: u64 = my_grant_payloads_to(catalog_ref, member)?.iter().filter(|(_, _, g)| matches!(g.reason, GrantReason::Carried { .. })).map(|(_, _, g)| u64::from(g.points)).sum();
    let Ok(points) = u32::try_from(held.saturating_sub(carried)) else { return Err(guest("that balance is too large to carry")) };
    if points == 0 {
        return Ok(None);
    }
    give(member.clone(), catalog_ref.clone(), Some(order.clone()), points, GrantReason::Carried { from }).map(Some)
}
