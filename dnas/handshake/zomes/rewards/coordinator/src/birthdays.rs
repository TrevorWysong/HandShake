//! Birthdays: the member's month, kept on their device and shared, sealed,
//! only with stores they've bought from; the store's sweep granting each
//! member's treat once a year.

use super::*;

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
    let orders = my_orders()?;
    let mut stores: Vec<ActionHash> = orders.iter().map(|(_, c, _)| c.clone()).collect();
    stores.sort();
    stores.dedup();
    let mut count = 0;
    for catalog_ref in stores.into_iter().filter(|c| !told.contains(c)) {
        let Ok(store_info) = store(&catalog_ref) else { continue };
        let sealed_month = seal(&store_info.owner, &month)?;
        let Some(order) = orders.iter().find(|(_, c, _)| c == &catalog_ref).map(|(o, _, _)| o.clone()) else { continue };
        let hash = create_entry(&EntryTypes::BirthdayShare(BirthdayShare { catalog_ref: catalog_ref.clone(), order, sealed_month }))?;
        create_link(catalog_ref, hash, LinkTypes::CatalogToBirthday, ())?;
        count += 1;
    }
    Ok(count)
}

/// How long a member must have ordered at a store before it celebrates
/// them: a fresh account set up for the birthday alone gets nothing.
pub(crate) const BIRTHDAY_AFTER_DAYS: i64 = 30;

/// How many members a store looks up a birth month for, each sweep, among
/// those it doesn't know yet -- taken in turn, so every member is reached.
pub(crate) const BIRTHDAYS_LOOKED_UP: usize = 200;

/// The caller's stores giving their birthday points to members whose month
/// it is: once a year each, to members who've ordered there for a while,
/// taking the first month each member told it. Only members are looked up,
/// each by their own key -- what anyone else links under the store is never
/// read -- and a month once read is kept privately (`MemberBirthday`).
/// Returns how many it gave.
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
        let catalog_ref = program.catalog_ref.clone();
        let local = local_time(now, &program.time_zone);
        // Members, by when they first ordered here, oldest first.
        let member_types = [EntryType::try_from(UnitEntryTypes::MemberOrder)?];
        let mut members: Vec<(AgentPubKey, Timestamp)> = Vec::new();
        for record in mine(&member_types).records()? {
            let Some(m) = decode_or::<MemberOrder>(&record).filter(|m| m.catalog_ref == catalog_ref) else { continue };
            let at = record.action().timestamp();
            match members.iter_mut().find(|(c, _)| c == &m.customer) {
                Some((_, first)) => *first = (*first).min(at),
                None => members.push((m.customer, at)),
            }
        }
        members.sort_by_key(|(_, at)| *at);
        let known_types = [EntryType::try_from(UnitEntryTypes::MemberBirthday)?];
        let mut known: Vec<(AgentPubKey, u8)> = mine(&known_types).records()?.iter().filter_map(decode_or::<MemberBirthday>).filter(|b| b.catalog_ref == catalog_ref).map(|b| (b.customer, b.month)).collect();
        // Look up some of those it doesn't know, in turn.
        let unknown: Vec<&AgentPubKey> = members.iter().map(|(c, _)| c).filter(|c| !known.iter().any(|(k, _)| k == *c)).collect();
        if !unknown.is_empty() {
            let turn = (now.as_micros() / 10_800_000_000) as usize % unknown.len().div_ceil(BIRTHDAYS_LOOKED_UP);
            for member in unknown.into_iter().skip(turn * BIRTHDAYS_LOOKED_UP).take(BIRTHDAYS_LOOKED_UP) {
                let query = LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToBirthday)?.author(member.clone());
                let Some(earliest) = get_links(query, GetStrategy::default())?.into_iter().min_by_key(|l| l.timestamp) else { continue };
                let Some(share) = earliest.target.into_action_hash().and_then(|h| get(h, GetOptions::default()).ok().flatten()).and_then(|r| decode_or::<BirthdayShare>(&r)) else { continue };
                let Some(month) = open::<u8>(member, &share.sealed_month)?.filter(|m| (1..=12).contains(m)) else { continue };
                create_entry(&EntryTypes::MemberBirthday(MemberBirthday { catalog_ref: catalog_ref.clone(), customer: member.clone(), month }))?;
                known.push((member.clone(), month));
            }
        }
        for (member, _) in known.into_iter().filter(|(_, m)| *m == local.month) {
            let first_order = members.iter().find(|(c, _)| c == &member).map(|(_, at)| *at);
            if !first_order.is_some_and(|at| now.as_micros() - at.as_micros() >= BIRTHDAY_AFTER_DAYS * 86_400_000_000) {
                continue;
            }
            // A member is someone who's bought here: an order the store settled,
            // not one called off in time, which cost them nothing.
            let mut bought = false;
            for view in member_orders(&catalog_ref, &member)? {
                if dispatch::<_, Option<ActionHash>>("order_settlement", view.order.clone())?.is_some() {
                    bought = true;
                    break;
                }
            }
            if !bought {
                continue;
            }
            let celebrated = my_grants_to(&catalog_ref, &member)?.iter().any(|(_, _, g)| matches!(g.reason, GrantReason::Birthday { year } if year == local.year));
            if celebrated {
                continue;
            }
            if handshake_coordinator_support::isolated::<_, ActionHash>("grant_birthday", BirthdayInput { to: member, catalog_ref: catalog_ref.clone(), points: program.birthday_points, year: local.year }).is_some() {
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
    grant(input.to, input.catalog_ref, None, input.points, GrantReason::Birthday { year: input.year })
}
