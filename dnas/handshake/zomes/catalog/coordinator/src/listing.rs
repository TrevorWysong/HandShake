//! Listing a store for customers to find, and finding the stores listed
//! near a place.

use super::*;
use crate::bags::BagView;
use handshake_coordinator_support::{current_of, get_links_many, latest_versions, read_records};

/// A store listed near somewhere: its original action, and where its
/// listing says it is (`LISTING_PRECISION`, which validation holds to the
/// store's own location).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct NearbyListing {
    pub catalog: ActionHash,
    pub geohash: String,
}

/// The stores listed in `geohash`'s cell and its 8 neighbors -- a store's
/// own cell size, the same grid drivers find open orders on, or its wider
/// area's (`AREA_PRECISION`) -- read from the listings alone, with
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
///
/// Read together, not one store after another: one read of every store's
/// version, move and bag links, one of their bags' version links, and one of
/// every record -- the host makes each read's requests at once, so a batch
/// costs three round trips however many stores are in it.
#[hdk_extern]
pub fn get_listed_stores(catalogs: Vec<ActionHash>) -> ExternResult<Vec<ListedStore>> {
    if catalogs.len() > STORE_BATCH {
        return Err(guest("Ask for fewer stores at once."));
    }
    let mut seen = std::collections::HashSet::new();
    let catalogs: Vec<ActionHash> = catalogs.into_iter().filter(|c| seen.insert(c.clone())).collect();
    let versions = |entry: &ActionHash| LinkQuery::try_new(entry.clone(), LinkTypes::Version);
    let mut queries = Vec::with_capacity(catalogs.len() * 3);
    for catalog in &catalogs {
        queries.extend([versions(catalog)?, LinkQuery::try_new(catalog.clone(), LinkTypes::CatalogToSuccessor)?, crate::bags::recent_bags_query(catalog)?]);
    }
    let links = get_links_many(queries)?;
    let mut tips = Vec::with_capacity(catalogs.len());
    let mut may_have_moved = Vec::with_capacity(catalogs.len());
    let mut bags: Vec<(usize, ActionHash)> = Vec::new();
    for (i, found) in links.chunks(3).enumerate() {
        let [versions_found, successors, bag_links] = found else { return Err(guest("couldn't read the stores")) };
        tips.push(current_of(versions_found.clone(), &catalogs[i]));
        may_have_moved.push(!successors.is_empty());
        bags.extend(bag_links.iter().filter_map(|link| link.target.clone().into_action_hash()).map(|bag| (i, bag)));
    }
    let bag_originals: Vec<ActionHash> = bags.iter().map(|(_, bag)| bag.clone()).collect();
    let mut wanted = tips;
    wanted.extend(latest_versions(&bag_originals, versions)?);
    let mut records = read_records(&wanted)?.into_iter();
    let store_records: Vec<Option<Record>> = records.by_ref().take(catalogs.len()).collect();

    let now = sys_time()?;
    let mut live: Vec<Vec<BagView>> = catalogs.iter().map(|_| Vec::new()).collect();
    for ((i, original), record) in bags.into_iter().zip(records) {
        live[i].extend(record.and_then(|record| crate::bags::live_bag(&catalogs[i], original, record, now)));
    }
    let mut stores = Vec::with_capacity(catalogs.len());
    for (((original_action, record), moved), bags) in catalogs.into_iter().zip(store_records).zip(may_have_moved).zip(live) {
        let Some(record) = record.filter(|r| decode_or::<MerchantCatalog>(r).is_some()) else { continue };
        // A move's link is the owner's word until the move itself checks out.
        if moved && moves::store_successor(original_action.clone())?.is_some() {
            continue;
        }
        stores.push(ListedStore { original_action, record, bags });
    }
    Ok(stores)
}

/// Lists a store (its original action) under its cell and its wider area
/// (`listing_cells`), saying where it is.
pub(crate) fn list(catalog_ref: &ActionHash, catalog: &MerchantCatalog) -> ExternResult<()> {
    for cell in listing_cells(&catalog.geohash) {
        create_link(geohash_anchor_path(cell)?.path_entry_hash()?, catalog_ref.clone(), LinkTypes::GeohashToCatalog, listing_tag(catalog))?;
    }
    Ok(())
}

/// The caller's listings of their store -- none if it isn't listed.
pub(crate) fn my_listings(catalog_ref: &ActionHash) -> ExternResult<Vec<Link>> {
    let (_, catalog): (_, MerchantCatalog) = resolve_latest_decoded(catalog_ref.clone(), "MerchantCatalog")?;
    let me = agent_info()?.agent_initial_pubkey;
    let target = AnyLinkableHash::from(catalog_ref.clone());
    let mut listings = Vec::new();
    for cell in listing_cells(&catalog.geohash) {
        let anchor = geohash_anchor_path(cell)?.path_entry_hash()?;
        listings.extend(get_links(LinkQuery::try_new(anchor, LinkTypes::GeohashToCatalog)?.author(me.clone()), GetStrategy::Local)?.into_iter().filter(|link| link.target == target));
    }
    Ok(listings)
}

/// Whether the caller's store is listed for customers to find.
#[hdk_extern]
pub fn is_store_listed(catalog_ref: ActionHash) -> ExternResult<bool> {
    Ok(!my_listings(&catalog_ref)?.is_empty())
}

/// Takes the caller's store out of customers' listings. The store keeps
/// answering the orders it has.
#[hdk_extern]
pub fn close_listing(catalog_ref: ActionHash) -> ExternResult<()> {
    let listings = my_listings(&catalog_ref)?;
    if listings.is_empty() {
        return Err(guest("This store isn't listed."));
    }
    for link in listings {
        delete_link(link.create_link_hash, GetOptions::default())?;
    }
    Ok(())
}

/// Lists the caller's store again.
#[hdk_extern]
pub fn reopen_listing(catalog_ref: ActionHash) -> ExternResult<()> {
    if !my_listings(&catalog_ref)?.is_empty() {
        return Ok(());
    }
    // Listed where it was published -- what validation checks it against.
    let original = get(catalog_ref.clone(), GetOptions::default())?.ok_or(guest("This store can't be found."))?;
    let catalog = decode_or::<MerchantCatalog>(&original).ok_or(guest("That isn't a store."))?;
    list(&catalog_ref, &catalog)
}
