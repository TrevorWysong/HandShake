//! A store's own history -- every version of its items, choice groups, store
//! and promo codes, from its owner's chain -- for the dispatch zome to check
//! an order against what the store actually offered.

use super::*;

/// One version of a menu item (or a choice group): the action that wrote
/// it, and when.
#[derive(Serialize, Deserialize, Debug)]
pub struct ItemVersion {
    pub action: ActionHash,
    pub written_at: Timestamp,
}

/// A menu item's name now, and every version of it, oldest first.
#[derive(Serialize, Deserialize, Debug)]
pub struct ItemVersions {
    pub item_ref: ActionHash,
    pub name: String,
    pub versions: Vec<ItemVersion>,
}

/// Every version of each of the caller's own menu items, from their source
/// chain -- complete and current, unlike a DHT read, since the caller wrote
/// each one. What a store checks an order's prices against (see
/// `dispatch::pricing::outdated_item`). An item the caller didn't write
/// comes back with no versions.
#[hdk_extern]
pub fn get_my_item_versions(item_refs: Vec<ActionHash>) -> ExternResult<Vec<ItemVersions>> {
    item_refs
        .into_iter()
        .map(|item_ref| {
            let versions = my_versions(item_ref.clone())?;
            let name = versions.last().and_then(|r| r.entry().to_app_option::<MenuItem>().ok().flatten()).map(|item| item.name).unwrap_or_default();
            let versions = versions.iter().map(|r| ItemVersion { action: r.action_address().clone(), written_at: r.action().timestamp() }).collect();
            Ok(ItemVersions { item_ref, name, versions })
        })
        .collect()
}

/// Every version of one of the caller's own stores, oldest first, from their
/// source chain -- what a store checks the terms an order cites against
/// (`dispatch::pricing::terms_outdated`). Empty if the caller didn't write it.
#[hdk_extern]
pub fn get_my_store_versions(catalog_ref: ActionHash) -> ExternResult<Vec<ItemVersion>> {
    Ok(my_versions(catalog_ref)?.iter().map(|r| ItemVersion { action: r.action_address().clone(), written_at: r.action().timestamp() }).collect())
}

/// One version of a promo code, as a store checks an order's promo against
/// it.
#[derive(Serialize, Deserialize, Debug)]
pub struct PromoVersion {
    pub active: bool,
    pub expires_at: Option<Timestamp>,
    pub written_at: Timestamp,
}

/// Every version of one of the caller's own promo codes, oldest first, from
/// their source chain -- what a store checks an order's promo against
/// before accepting it (`dispatch::pricing::outdated_item`). Empty if the
/// caller didn't write it.
#[hdk_extern]
pub fn get_my_promo_versions(promo_ref: ActionHash) -> ExternResult<Vec<PromoVersion>> {
    Ok(my_versions(promo_ref)?
        .iter()
        .filter_map(|record| {
            let promo = record.entry().to_app_option::<PromoCode>().ok().flatten()?;
            Some(PromoVersion { active: promo.active, expires_at: promo.expires_at, written_at: record.action().timestamp() })
        })
        .collect())
}
