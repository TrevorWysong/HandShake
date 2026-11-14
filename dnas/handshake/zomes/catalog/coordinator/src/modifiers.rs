//! A store's choice groups ("Size", "Milk", "Choose a side") -- shared by
//! the items that list them, as on DoorDash and Uber Eats (see
//! `catalog_types::modifiers`).

use crate::{ItemVersion, ItemVersions};
use catalog_integrity::*;
use hdk::prelude::*;
use handshake_coordinator_support::chain::{my_current_version, my_versions};
use handshake_coordinator_support::{decode_or, guest, resolve_latest, resolve_links_to_records_with_original, resolve_version, update_version, written};

/// A choice group's stable identity (its original action -- what items and
/// orders name) alongside its latest content.
#[derive(Serialize, Deserialize, Debug)]
pub struct ModifierGroupView {
    pub original_action: ActionHash,
    pub record: Record,
}

#[hdk_extern]
pub fn create_modifier_group(group: ModifierGroup) -> ExternResult<Record> {
    let catalog_ref = group.catalog_ref.clone();
    let action_hash = create_entry(&EntryTypes::ModifierGroup(group))?;
    create_link(catalog_ref, action_hash.clone(), LinkTypes::CatalogToModifierGroup, ())?;
    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateModifierGroupInput {
    pub original_action: ActionHash,
    pub group: ModifierGroup,
}

/// A new version of a choice group -- every item listing it offers the new
/// options and prices from now on; orders already placed keep the version
/// they were priced at.
#[hdk_extern]
pub fn update_modifier_group(input: UpdateModifierGroupInput) -> ExternResult<Record> {
    // Built on the caller's own latest version, which this device always
    // has: building on an older one would fork the group's history.
    let current = match my_current_version(input.original_action.clone())? {
        Some(current) => current,
        None => resolve_version(input.original_action)?,
    };
    let updated = update_version(&current, &EntryTypes::ModifierGroup(input.group), LinkTypes::Version)?;
    written(updated)
}

/// Takes a choice group off its store's list -- only once no item offers it
/// and no other group's option opens it, so nothing a customer can order
/// names a group the store has dropped. Orders already placed keep the
/// version they were priced at, and the record stays, as every catalog
/// entry does.
#[hdk_extern]
pub fn remove_modifier_group(original_action: ActionHash) -> ExternResult<()> {
    let current = my_current_version(original_action.clone())?.ok_or(guest("Only its store's owner can remove a choice group."))?;
    let group = decode_or::<ModifierGroup>(&current.record).ok_or(guest("That isn't a choice group."))?;
    let me = agent_info()?.agent_initial_pubkey;
    let target = AnyLinkableHash::from(original_action.clone());
    for link in get_links(LinkQuery::try_new(group.catalog_ref.clone(), LinkTypes::CatalogToMenuItem)?.author(me.clone()), GetStrategy::Local)? {
        let Some(item_ref) = link.target.into_action_hash() else { continue };
        let Some(item) = my_current_version(item_ref)?.and_then(|version| decode_or::<MenuItem>(&version.record)) else { continue };
        if item.modifier_groups.contains(&original_action) {
            return Err(guest("An item still offers this choice group: take it off the item first."));
        }
    }
    let groups = get_links(LinkQuery::try_new(group.catalog_ref.clone(), LinkTypes::CatalogToModifierGroup)?.author(me), GetStrategy::Local)?;
    for link in &groups {
        let Some(other_ref) = link.target.clone().into_action_hash() else { continue };
        if other_ref == original_action {
            continue;
        }
        let Some(other) = my_current_version(other_ref)?.and_then(|version| decode_or::<ModifierGroup>(&version.record)) else { continue };
        if other.options.iter().any(|option| option.nested_group.as_ref() == Some(&original_action)) {
            return Err(guest("Another choice group's option still opens this one: change that option first."));
        }
    }
    for link in groups.into_iter().filter(|link| link.target == target) {
        delete_link(link.create_link_hash, GetOptions::default())?;
    }
    Ok(())
}

/// Every choice group a store has -- what its owner manages.
#[hdk_extern]
pub fn list_modifier_groups(catalog_ref: ActionHash) -> ExternResult<Vec<ModifierGroupView>> {
    let links = get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToModifierGroup)?, GetStrategy::default())?;
    Ok(views(resolve_links_to_records_with_original(links), &catalog_ref))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GetModifierGroupsInput {
    pub catalog_ref: ActionHash,
    /// Groups by original action: an item's, and those its options open.
    pub groups: Vec<ActionHash>,
}

/// Some of a store's choice groups at their latest -- what a customer's
/// item sheet reads: only the groups the item offers, however many the
/// store has. Groups that aren't the store's are left out.
#[hdk_extern]
pub fn get_modifier_groups(input: GetModifierGroupsInput) -> ExternResult<Vec<ModifierGroupView>> {
    if input.groups.len() > MAX_GROUPS_PER_READ {
        return Err(guest(format!("read at most {MAX_GROUPS_PER_READ} choice groups at once")));
    }
    let mut found = Vec::with_capacity(input.groups.len());
    for group in input.groups {
        if let Ok(record) = resolve_latest(group.clone()) {
            found.push((group, record));
        }
    }
    Ok(views(found, &input.catalog_ref))
}

/// An item's groups and every group they can open, nested to the limit.
const MAX_GROUPS_PER_READ: usize = handshake_integrity_support::limits::MAX_ITEM_GROUPS * handshake_integrity_support::limits::MAX_GROUP_OPTIONS;

fn views(found: Vec<(ActionHash, Record)>, catalog_ref: &ActionHash) -> Vec<ModifierGroupView> {
    found
        .into_iter()
        .filter(|(_, record)| decode_or::<ModifierGroup>(record).is_some_and(|g| &g.catalog_ref == catalog_ref))
        .map(|(original_action, record)| ModifierGroupView { original_action, record })
        .collect()
}

/// Every version of each of the caller's own choice groups, from their
/// source chain -- what a store checks an order's choices against
/// (`dispatch::pricing::outdated_item`), as it does its items' prices. A
/// group the caller didn't write comes back with no versions.
#[hdk_extern]
pub fn get_my_group_versions(group_refs: Vec<ActionHash>) -> ExternResult<Vec<ItemVersions>> {
    group_refs
        .into_iter()
        .map(|group_ref| {
            let versions = my_versions(group_ref.clone())?;
            let name = versions.last().and_then(decode_or::<ModifierGroup>).map(|g| g.name).unwrap_or_default();
            let versions = versions.iter().map(|r| ItemVersion { action: r.action_address().clone(), written_at: r.action().timestamp() }).collect();
            Ok(ItemVersions { item_ref: group_ref, name, available: true, versions })
        })
        .collect()
}

