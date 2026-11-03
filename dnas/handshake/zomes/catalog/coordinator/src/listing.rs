//! Listing a store for customers to find, and finding the stores listed
//! near a place.

use super::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct NearbyMerchantsInput {
    pub geohash: String,
    /// Page cursor -- pass back the previous call's `next_after` to continue.
    /// `None` starts from the beginning.
    pub after: Option<Timestamp>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct NearbyMerchantsPage {
    pub catalogs: Vec<CatalogView>,
    pub next_after: Option<Timestamp>,
}

/// Returns merchant catalogs declared in `geohash`'s cell and its 8
/// neighbors -- the same discovery pattern drivers use for open orders, so
/// restaurant browsing and order discovery compose over one grid. Paginated,
/// not time-bucketed like open-order discovery -- old catalogs are signal here, not noise,
/// so bucketing would just mean re-linking every merchant forever instead
/// of fixing anything. `after` filtering happens per-cell before the
/// cross-cell merge below, so it also reduces per-cell payload size, not
/// just the final page.
#[hdk_extern]
pub fn get_nearby_merchants(input: NearbyMerchantsInput) -> ExternResult<NearbyMerchantsPage> {
    let mut links = Vec::new();
    for cell in handshake_types::cell_and_neighbors(&input.geohash) {
        let path = geohash_anchor_path(&cell)?;
        let path_hash = match path.path_entry_hash() {
            Ok(hash) => hash,
            Err(_) => continue,
        };
        let mut query = LinkQuery::try_new(path_hash, LinkTypes::GeohashToCatalog)?;
        query.after = input.after;
        links.extend(get_links(query, GetStrategy::default())?);
    }
    links.sort_by_key(|l| l.timestamp);
    let next_after = if links.len() > CATALOG_PAGE_SIZE {
        Some(next_page_cursor(links[CATALOG_PAGE_SIZE - 1].timestamp))
    } else {
        None
    };
    links.truncate(CATALOG_PAGE_SIZE);
    let mut catalogs = Vec::new();
    let mut seen: Vec<ActionHash> = Vec::new();
    for (original_action, record) in resolve_links_to_records_with_original(links) {
        // Once each; and a store whose owner moved it to a new key shows as
        // the new one.
        if !seen.contains(&original_action) && !moves::has_moved(&original_action)? {
            seen.push(original_action.clone());
            catalogs.push(CatalogView { original_action, record });
        }
    }
    Ok(NearbyMerchantsPage { catalogs, next_after })
}

/// Lists a store (its original action) under its area.
pub(crate) fn list(catalog_ref: &ActionHash, geohash: &str) -> ExternResult<ActionHash> {
    create_link(geohash_anchor_path(geohash)?.path_entry_hash()?, catalog_ref.clone(), LinkTypes::GeohashToCatalog, ())
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
    let (_, catalog): (_, MerchantCatalog) = resolve_latest_decoded(catalog_ref.clone(), "MerchantCatalog")?;
    list(&catalog_ref, &catalog.geohash).map(|_| ())
}
