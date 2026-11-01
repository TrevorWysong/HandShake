//! Integrity zome for stores' rewards programs. See `rewards_types` for the
//! model, and docs/REWARDS.md.
//!
//! What validation guarantees:
//!
//! - **A program is its store's.** Only the store's owner writes it, once,
//!   and changes it by updating it; everything it names is on that store's
//!   menu, and every limit holds (`RewardsProgram::problem`).
//! - **Nothing about a member's points is published.** There's no points
//!   ledger to validate: a member's points follow from records the store
//!   holds, and the store checks them before it honours a reward. A store's
//!   grant and a member's birth month are sealed between the two; the
//!   store's own record of its members' orders, and a member's own birth
//!   month, are private to their device.

use handshake_integrity_support::{classify, decode, invalid, linked_record, original_creation, require, valid, Checked};
use hdi::prelude::*;
pub use rewards_types::*;
use catalog_types::{MenuItem, MerchantCatalog};

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    RewardsProgram(RewardsProgram),
    PointsGrant(PointsGrant),
    #[entry_type(visibility = "private")]
    BirthMonth(BirthMonth),
    BirthdayShare(BirthdayShare),
    #[entry_type(visibility = "private")]
    MemberOrder(MemberOrder),
    #[entry_type(visibility = "private")]
    MemberBirthday(MemberBirthday),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// An entry's update, base = its original, tagged with how deep it is
    /// (`handshake_integrity_support::versions`). First in every zome.
    Version,
    /// A store's program, base = the store.
    CatalogToProgram,
    /// A store's grant, base = whoever it's to, so they find it.
    AgentToGrant,
    /// A member's sealed birth month, base = the store it's for.
    CatalogToBirthday,
}

const _: () = assert!(LinkTypes::Version as u8 == handshake_integrity_support::versions::VERSION_LINK_TYPE, "Version must be the first link type");

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match classify(op.flattened::<EntryTypes, LinkTypes>()?)? {
        Checked::Create { entry, action } => match entry {
            EntryTypes::RewardsProgram(program) => validate_new_program(&program, action.author(), action.prev_action()),
            EntryTypes::PointsGrant(grant) => sealed_problem("a grant", &grant.sealed),
            EntryTypes::BirthdayShare(share) => match store_owner(&share.catalog_ref)? {
                Some(_) => sealed_problem("a birthday", &share.sealed_month),
                None => invalid("a birthday is shared with a store, by its original action"),
            },
            // Private to their author's device: checked as they write them.
            EntryTypes::BirthMonth(month) => require((1..=12).contains(&month.month), "a birth month is between 1 and 12"),
            EntryTypes::MemberOrder(_) => valid(),
            EntryTypes::MemberBirthday(b) => require((1..=12).contains(&b.month), "a birth month is between 1 and 12"),
        },
        Checked::Update { entry: EntryTypes::RewardsProgram(program), action } => validate_program_update(&program, action.author(), &action.original_action_address),
        Checked::Update { .. } => invalid("only a program changes"),
        Checked::Delete { .. } => invalid("rewards records can't be deleted"),
        Checked::CreateLink { link_type: LinkTypes::Version, action } => handshake_integrity_support::versions::validate_version_link(&action.base_address, &action.target_address, &action.tag, action.author()),
        Checked::CreateLink { link_type, action } => validate_create_link(link_type, &action.base_address, &action.target_address, action.author()),
        Checked::DeleteLink { .. } => invalid("rewards links can't be deleted"),
        Checked::Other => valid(),
    }
}

/// A sealed field no larger than a grant or a birthday ever needs.
fn sealed_problem(what: &str, sealed: &XSalsa20Poly1305EncryptedData) -> ExternResult<ValidateCallbackResult> {
    match handshake_integrity_support::sealed_problem("sealed", sealed, MAX_SEALED_GRANT_BYTES) {
        Some(_) => invalid(&format!("{what} is sealed, and small")),
        None => valid(),
    }
}

// --- programs ---

/// The owner of the store `catalog_ref` names (its original action), if it
/// is one, and when it opened.
fn store_owner(catalog_ref: &ActionHash) -> ExternResult<Option<(AgentPubKey, Timestamp)>> {
    if &original_creation(catalog_ref.clone())? != catalog_ref {
        return Ok(None);
    }
    let record = must_get_valid_record(catalog_ref.clone())?;
    Ok(decode::<MerchantCatalog>(&record).map(|store| (store.owner, record.action().timestamp())))
}

/// A program's limits, and that everything it names is on its store's menu,
/// by the item's identity.
fn check_program(program: &RewardsProgram) -> ExternResult<Option<String>> {
    if let Some(problem) = program.problem() {
        return Ok(Some(problem));
    }
    for item_ref in program.items() {
        if &original_creation(item_ref.clone())? != item_ref {
            return Ok(Some("a program names an item by its original action".into()));
        }
        let ours = decode::<MenuItem>(&must_get_valid_record(item_ref.clone())?).is_some_and(|item| item.catalog_ref == program.catalog_ref);
        if !ours {
            return Ok(Some("a program names only its own store's items".into()));
        }
    }
    Ok(None)
}

fn validate_new_program(program: &RewardsProgram, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some((owner, opened)) = store_owner(&program.catalog_ref)? else { return invalid("a program is for a store, by its original action") };
    if &owner != author {
        return invalid("only a store's owner runs its program");
    }
    if let Some(problem) = check_program(program)? {
        return invalid(&problem);
    }
    let Some(prev) = prev_action else { return invalid("a program can't open a chain") };
    // Once per store: every later change is an update of it.
    let again = handshake_integrity_support::chain::wrote_since(author, prev, opened, UnitEntryTypes::RewardsProgram.try_into()?, |p: &RewardsProgram| p.catalog_ref == program.catalog_ref)?;
    require(!again, "a store has one program; change it by updating it")
}

fn validate_program_update(program: &RewardsProgram, author: &AgentPubKey, original: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original.clone())?;
    let Some(prior) = decode::<RewardsProgram>(&prior_record) else { return invalid("a program updates a program") };
    if prior_record.action().author() != author || prior.catalog_ref != program.catalog_ref {
        return invalid("only its owner changes a program, and it stays with its store");
    }
    match check_program(program)? {
        Some(problem) => invalid(&problem),
        None => valid(),
    }
}

// --- links ---

fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = linked_record(target)? else { return invalid("rewards links target a record") };
    if record.action().author() != author {
        return invalid("a rewards link is made by whoever wrote what it points at");
    }
    let expected: Option<AnyLinkableHash> = match link_type {
        LinkTypes::Version => return invalid("a version link is validated as one"),
        LinkTypes::CatalogToProgram => decode::<RewardsProgram>(&record).filter(|_| matches!(record.action().data, ActionData::Create(_))).map(|p| p.catalog_ref.into()),
        LinkTypes::AgentToGrant => decode::<PointsGrant>(&record).map(|g| g.to.into()),
        LinkTypes::CatalogToBirthday => decode::<BirthdayShare>(&record).map(|b| b.catalog_ref.into()),
    };
    match expected {
        Some(expected) => require(&expected == base, "a rewards link sits under the store or member its record is about"),
        None => invalid("a rewards link's target is not the record its link type indexes"),
    }
}
