//! A store's rewards program: saving it, and reading it back -- the store's
//! own versions, and the one a customer's order joins.

use super::*;

/// A store's program at its current version.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProgramView {
    /// The program's identity (its original action).
    pub original: ActionHash,
    /// Its current version -- what an order placed now cites.
    pub version: ActionHash,
    pub program: RewardsProgram,
}

pub(crate) fn program_links(catalog_ref: &ActionHash) -> ExternResult<Vec<Link>> {
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
pub(crate) fn my_program(catalog_ref: &ActionHash) -> ExternResult<Option<handshake_coordinator_support::EntryVersion>> {
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
