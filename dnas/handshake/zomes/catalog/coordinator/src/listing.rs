//! Listing a store for customers to find -- backed by a stake from its
//! owner's balance -- and finding the stores listed near a place.

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
    for (original_action, record) in resolve_links_to_records_with_original(links) {
        // A store whose owner moved it to a new key shows as the new one.
        if !moves::has_moved(&original_action)? {
            catalogs.push(CatalogView { original_action, record });
        }
    }
    Ok(NearbyMerchantsPage { catalogs, next_after })
}

/// Lists a store (its original action) under its area, backed by a stake
/// from the owner's balance (`ledger::stake_listing`) -- in this same call,
/// so the two commit together.
pub(crate) fn list(catalog_ref: &ActionHash, geohash: &str) -> ExternResult<ActionHash> {
    let stake: ActionHash = call_local("ledger", "stake_listing", catalog_ref.clone())?
        .map_err(|_| guest("Listing a store sets aside a deposit from your balance, returned when you close it. Add funds to list it."))?;
    create_link(geohash_anchor_path(geohash)?.path_entry_hash()?, catalog_ref.clone(), LinkTypes::GeohashToCatalog, LinkTag::new(listing_tag(&stake)))
}

/// The caller's listing of their store, if it's listed: the link, and the
/// stake that backs it.
pub(crate) fn my_listing(catalog_ref: &ActionHash) -> ExternResult<Option<(Link, ActionHash)>> {
    let (_, catalog): (_, MerchantCatalog) = resolve_latest_decoded(catalog_ref.clone(), "MerchantCatalog")?;
    let me = agent_info()?.agent_initial_pubkey;
    let anchor = geohash_anchor_path(&catalog.geohash)?.path_entry_hash()?;
    let target = AnyLinkableHash::from(catalog_ref.clone());
    Ok(get_links(LinkQuery::try_new(anchor, LinkTypes::GeohashToCatalog)?.author(me), GetStrategy::Local)?
        .into_iter()
        .filter(|link| link.target == target)
        .find_map(|link| listing_stake(&link.tag.0).map(|stake| (link, stake))))
}

/// Whether the caller's store is listed for customers to find.
#[hdk_extern]
pub fn is_store_listed(catalog_ref: ActionHash) -> ExternResult<bool> {
    Ok(my_listing(&catalog_ref)?.is_some())
}

/// Takes the caller's store out of customers' listings and returns its
/// stake, in one commit. The store keeps answering the orders it has.
#[hdk_extern]
pub fn close_listing(catalog_ref: ActionHash) -> ExternResult<()> {
    let Some((link, stake)) = my_listing(&catalog_ref)? else { return Err(guest("This store isn't listed.")) };
    let delisting = delete_link(link.create_link_hash, GetOptions::default())?;
    #[derive(Serialize, Debug)]
    struct UnstakeWire {
        stake: ActionHash,
        delisting: ActionHash,
    }
    call_local::<_, serde::de::IgnoredAny>("ledger", "unstake_listing", UnstakeWire { stake, delisting })?.map(drop).map_err(|why| guest(format!("couldn't return the listing deposit: {why}")))
}

/// Lists the caller's store again, with a fresh stake.
#[hdk_extern]
pub fn reopen_listing(catalog_ref: ActionHash) -> ExternResult<()> {
    if my_listing(&catalog_ref)?.is_some() {
        return Ok(());
    }
    let (_, catalog): (_, MerchantCatalog) = resolve_latest_decoded(catalog_ref.clone(), "MerchantCatalog")?;
    list(&catalog_ref, &catalog.geohash).map(|_| ())
}
