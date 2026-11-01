//! Points a store grants a member -- sealed between the two, and only ever
//! for an order the member placed there.

use super::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct GrantInput {
    pub to: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub points: u32,
    pub note: String,
    /// An order of theirs at the store to cite -- by default, their latest
    /// one under its program.
    #[serde(default)]
    pub order: Option<ActionHash>,
}

/// The caller's store's latest record of an order `customer` placed under
/// its program -- what a grant to them cites.
pub(crate) fn latest_member_order(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    let types = [EntryType::try_from(UnitEntryTypes::MemberOrder)?];
    Ok(mine(&types).find(|r| decode_or::<MemberOrder>(r).is_some_and(|m| &m.customer == customer && &m.catalog_ref == catalog_ref))?.and_then(|r| decode_or::<MemberOrder>(&r)).map(|m| m.order))
}

pub(crate) fn grant(to: AgentPubKey, catalog_ref: ActionHash, order: Option<ActionHash>, points: u32, reason: GrantReason) -> ExternResult<ActionHash> {
    if points == 0 || points > MAX_GRANT_POINTS {
        return Err(guest(format!("You can give between 1 and {MAX_GRANT_POINTS} points at a time.")));
    }
    let order = match order {
        Some(order) => order,
        None => latest_member_order(&catalog_ref, &to)?.ok_or(guest("You can give points only to customers who've ordered here."))?,
    };
    let sealed = seal(&to, &GrantPayload { points, reason })?;
    let hash = create_entry(&EntryTypes::PointsGrant(PointsGrant { to: to.clone(), catalog_ref, order, sealed }))?;
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
    grant(input.to, input.catalog_ref, input.order, input.points, GrantReason::Goodwill { note: input.note })
}

/// The grants `owner`'s store `catalog_ref` gave the caller, opened. Read by
/// the owner's key, all of them -- as many as it counts itself -- so nobody
/// else's, however many, can crowd them out; and only the key that sealed
/// one can have sent it.
pub(crate) fn grants_from(owner: &AgentPubKey, catalog_ref: &ActionHash) -> ExternResult<Vec<GrantToMe>> {
    let query = LinkQuery::try_new(me()?, LinkTypes::AgentToGrant)?.author(owner.clone());
    let mut out = Vec::new();
    for link in get_links(query, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash, GetOptions::default())? else { continue };
        let Some(grant) = decode_or::<PointsGrant>(&record).filter(|g| &g.catalog_ref == catalog_ref) else { continue };
        if record.action().author() != owner {
            continue;
        }
        if let Some(payload) = open::<GrantPayload>(owner, &grant.sealed)? {
            out.push(GrantToMe { grant: record.action_address().clone(), at: record.action().timestamp(), payload });
        }
    }
    Ok(out)
}

/// A grant to the caller, opened.
pub(crate) struct GrantToMe {
    pub(crate) grant: ActionHash,
    pub(crate) at: Timestamp,
    pub(crate) payload: GrantPayload,
}
