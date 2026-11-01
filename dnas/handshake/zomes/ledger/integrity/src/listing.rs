//! A store's listing stake: set aside to list it, back once the listing is
//! taken down.

use super::*;

/// A store's listing stake: its owner's, for the network's amount, naming
/// the store by its original action.
pub(crate) fn validate_stake(entry: &LedgerEntry, catalog: &ActionHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let record = must_get_valid_record(catalog.clone())?;
    let Some(store) = decode::<MerchantCatalog>(&record) else { return invalid("a stake backs a store") };
    if !matches!(record.action().data, ActionData::Create(_)) || &store.owner != author {
        return invalid("a stake backs its author's own store, named by its original action");
    }
    require(entry.amount == handshake_governance::store_listing_stake(), "a listing stake is the network's amount")
}

/// A listing stake taken back: the author's own, once, for what it set
/// aside, citing their deletion of the very listing it backed -- so a stake
/// never comes back while its listing stands.
pub(crate) fn validate_unstake(entry: &LedgerEntry, stake_ref: &ActionHash, delisting: &ActionHash, author: &AgentPubKey, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let stake_record = must_get_valid_record(stake_ref.clone())?;
    let Some(LedgerEntry { kind: LedgerKind::Stake { catalog }, amount, .. }) = decode::<LedgerEntry>(&stake_record) else {
        return invalid("an unstake takes back a stake");
    };
    if stake_record.action().author() != author || entry.amount != amount {
        return invalid("an unstake takes back exactly its author's own stake");
    }
    if !deletes_listing(delisting, stake_ref, &catalog, author)? {
        return invalid("a stake comes back only once its listing is deleted, cited by that deletion");
    }
    let staked_at = stake_record.action().timestamp();
    let again = ledger_since(author, prev_action, staked_at)?.iter().any(|e| matches!(&e.entry.kind, LedgerKind::Unstake { stake, .. } if stake == stake_ref));
    require(!again, "a stake comes back once")
}

/// Whether `delisting` is `author`'s deletion of the listing `stake` backed:
/// a catalog link to `catalog` whose tag names the stake (a tag only a
/// listing may carry -- see `catalog_types::LISTING_TAG_PREFIX`).
pub(crate) fn deletes_listing(delisting: &ActionHash, stake: &ActionHash, catalog: &ActionHash, author: &AgentPubKey) -> ExternResult<bool> {
    let delete = must_get_action(delisting.clone())?;
    let ActionData::DeleteLink(delete_link) = &delete.hashed.content.data else { return Ok(false) };
    if delete.hashed.content.header.author != *author {
        return Ok(false);
    }
    let created = must_get_action(delete_link.link_add_address.clone())?;
    let ActionData::CreateLink(link) = &created.hashed.content.data else { return Ok(false) };
    let catalog_zome = dna_info()?.zome_names.iter().position(|name| name.0 == CATALOG_INTEGRITY_ZOME);
    Ok(catalog_zome.is_some_and(|index| usize::from(link.zome_index.0) == index)
        && link.tag.0 == listing_tag(stake)
        && link.target_address == AnyLinkableHash::from(catalog.clone()))
}
