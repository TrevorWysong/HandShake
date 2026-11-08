//! Listing a store for customers to find, and finding the stores listed
//! near a place.

use super::*;

/// A store listed near somewhere: its original action, and where its
/// listing says it is (`LISTING_PRECISION`, which validation holds to the
/// store's own location).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct NearbyListing {
    pub catalog: ActionHash,
    pub geohash: String,
}

/// The stores listed in `geohash`'s cell and its 8 neighbors -- the same
/// grid drivers find open orders on -- read from the listings alone, with
/// no store's record fetched: a dense area's few thousand cost one link read
/// per cell. An app ranks them by distance and reads only the ones it shows
/// (`get_listed_stores`). Old listings are signal here, not noise -- a store
/// listed a year ago is still near today -- so the anchor isn't
/// time-bucketed.
#[hdk_extern]
pub fn get_nearby_listings(geohash: String) -> ExternResult<Vec<NearbyListing>> {
    let mut listings: Vec<NearbyListing> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for cell in handshake_types::cell_and_neighbors(&geohash) {
        let Ok(anchor) = geohash_anchor_path(&cell)?.path_entry_hash() else { continue };
        for link in get_links(LinkQuery::try_new(anchor, LinkTypes::GeohashToCatalog)?, GetStrategy::default())? {
            let (Some(catalog), Ok(geohash)) = (link.target.into_action_hash(), String::from_utf8(link.tag.0)) else { continue };
            if seen.insert(catalog.clone()) {
                listings.push(NearbyListing { catalog, geohash });
            }
        }
    }
    Ok(listings)
}

/// The most stores `get_listed_stores` reads at once.
pub const STORE_BATCH: usize = 50;

/// A store as a list of nearby stores shows it: its current record, and the
/// goodie bags it has out.
#[derive(Serialize, Deserialize, Debug)]
pub struct ListedStore {
    pub original_action: ActionHash,
    pub record: Record,
    pub bags: Vec<BagView>,
}

/// The stores at `catalogs` (original actions), as of now, at most
/// `STORE_BATCH` at a time -- each one that's still a store, once; one its
/// owner moved to a new key is left out, the new one being listed itself.
#[hdk_extern]
pub fn get_listed_stores(catalogs: Vec<ActionHash>) -> ExternResult<Vec<ListedStore>> {
    if catalogs.len() > STORE_BATCH {
        return Err(guest("Ask for fewer stores at once."));
    }
    let mut stores: Vec<ListedStore> = Vec::with_capacity(catalogs.len());
    for original_action in catalogs {
        if stores.iter().any(|s| s.original_action == original_action) || moves::has_moved(&original_action)? {
            continue;
        }
        let Ok(record) = resolve_latest(original_action.clone()) else { continue };
        if decode_or::<MerchantCatalog>(&record).is_none() {
            continue;
        }
        let bags = crate::bags::live_bags(&original_action)?;
        stores.push(ListedStore { original_action, record, bags });
    }
    Ok(stores)
}

/// Lists a store (its original action) under its area, saying where it is.
pub(crate) fn list(catalog_ref: &ActionHash, catalog: &MerchantCatalog) -> ExternResult<ActionHash> {
    create_link(geohash_anchor_path(&catalog.geohash)?.path_entry_hash()?, catalog_ref.clone(), LinkTypes::GeohashToCatalog, listing_tag(catalog))
}

/// The caller's listing of their store, if it's listed.
pub(crate) fn my_listing(catalog_ref: &ActionHash) -> ExternResult<Option<Link>> {
    let (_, catalog): (_, MerchantCatalog) = resolve_latest_decoded(catalog_ref.clone(), "MerchantCatalog")?;
    let me = agent_info()?.agent_initial_pubkey;
    let anchor = geohash_anchor_path(&catalog.geohash)?.path_entry_hash()?;
    let target = AnyLinkableHash::from(catalog_ref.clone());
    Ok(get_links(LinkQuery::try_new(anchor, LinkTypes::GeohashToCatalog)?.author(me), GetStrategy::Local)?
        .into_iter()
        .find(|link| link.target == target))
}

/// Whether the caller's store is listed for customers to find.
#[hdk_extern]
pub fn is_store_listed(catalog_ref: ActionHash) -> ExternResult<bool> {
    Ok(my_listing(&catalog_ref)?.is_some())
}

/// Takes the caller's store out of customers' listings. The store keeps
/// answering the orders it has.
#[hdk_extern]
pub fn close_listing(catalog_ref: ActionHash) -> ExternResult<()> {
    let Some(link) = my_listing(&catalog_ref)? else { return Err(guest("This store isn't listed.")) };
    delete_link(link.create_link_hash, GetOptions::default())?;
    Ok(())
}

/// Lists the caller's store again.
#[hdk_extern]
pub fn reopen_listing(catalog_ref: ActionHash) -> ExternResult<()> {
    if my_listing(&catalog_ref)?.is_some() {
        return Ok(());
    }
    // Listed where it was published -- what validation checks it against.
    let original = get(catalog_ref.clone(), GetOptions::default())?.ok_or(guest("This store can't be found."))?;
    let catalog = decode_or::<MerchantCatalog>(&original).ok_or(guest("That isn't a store."))?;
    list(&catalog_ref, &catalog).map(|_| ())
}
