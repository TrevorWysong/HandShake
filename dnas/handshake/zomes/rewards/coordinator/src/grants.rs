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

/// The member's latest order at the caller's store under its program --
/// what a grant to them cites: from the store's account of them, or, when
/// it has none (a device just restored, say), the newest of the store's
/// links to their orders.
pub(crate) fn latest_member_order(catalog_ref: &ActionHash, customer: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    if let Some(order) = account(catalog_ref, customer, true)?.value.and_then(|a| a.latest_order) {
        return Ok(Some(order));
    }
    let newest = member_order_links(customer, catalog_ref, &me()?, None)?.into_iter().max_by_key(|link| link.timestamp);
    Ok(newest.and_then(|link| parse_member_order_tag(&link.tag.0)).map(|(_, order)| order))
}

pub(crate) fn grant(to: AgentPubKey, catalog_ref: ActionHash, order: Option<ActionHash>, points: u32, reason: GrantReason) -> ExternResult<ActionHash> {
    // A gift or a birthday is bounded; a balance carried over is what it was.
    let given = !matches!(reason, GrantReason::Carried { .. });
    if points == 0 || (given && points > MAX_GRANT_POINTS) {
        return Err(guest(format!("You can give between 1 and {MAX_GRANT_POINTS} points at a time.")));
    }
    let order = match order {
        Some(order) => order,
        None => latest_member_order(&catalog_ref, &to)?.ok_or(guest("You can give points only to customers who've ordered here."))?,
    };
    let payload = GrantPayload { points, reason };
    let sealed = seal(&to, &payload)?;
    let hash = create_entry(&EntryTypes::PointsGrant(PointsGrant { to: to.clone(), catalog_ref: catalog_ref.clone(), order, sealed }))?;
    create_link(to.clone(), hash.clone(), LinkTypes::AgentToGrant, ())?;
    // Dated as the member reads it: by the grant's own record.
    let at = get(hash.clone(), GetOptions::local())?.map_or(sys_time()?, |r| r.action().timestamp());
    record_grant(&catalog_ref, &to, open_grant(hash.clone(), at, &payload))?;
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

/// The grants `owner`'s store `catalog_ref` gave the caller, opened, but
/// for those `folded` into their account already -- passed over before
/// they're fetched. Read by the owner's key, all of them -- as many as it
/// counts itself -- so nobody else's, however many, can crowd them out;
/// and only the key that sealed one can have sent it.
pub(crate) fn grants_from(owner: &AgentPubKey, catalog_ref: &ActionHash, folded: &[ActionHash]) -> ExternResult<Vec<GrantToMe>> {
    let query = LinkQuery::try_new(me()?, LinkTypes::AgentToGrant)?.author(owner.clone());
    let mut out = Vec::new();
    for link in get_links(query, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if folded.contains(&hash) {
            continue;
        }
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
