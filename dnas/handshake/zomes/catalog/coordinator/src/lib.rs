//! Coordinator zome for merchant catalogs: publishing a store and reading it
//! back, here; its settings (`settings`), menu (`menu`, `modifiers`), own
//! history (`versions`), promo codes (`promos`), goodie bags and their
//! claims (`bags`), listing and geohash-anchor discovery ("restaurants near
//! me", `listing`) -- the same anchor pattern drivers use to find open
//! orders -- and moving a store to a new key or network (`moves`).

mod bags;
mod listing;
mod menu;
mod modifiers;
mod moves;
mod promos;
mod settings;
mod signals;
mod versions;
pub use bags::*;
pub use listing::*;
pub use menu::*;
pub use modifiers::*;
pub use moves::*;
pub use promos::*;
pub use settings::*;
pub use signals::*;
pub use versions::*;

use catalog_integrity::*;
use hdi::hash_path::path::Path;
use hdk::prelude::*;
use handshake_coordinator_support::chain::{my_current_version, my_versions};
use handshake_coordinator_support::{call_local, decode_or, guest, next_page_cursor, resolve_latest, resolve_latest_decoded, resolve_links_to_records_with_original, resolve_version, resolve_version_decoded, update_version, written};
use handshake_integrity_support::contact::{email_problem, website_problem};
use handshake_types::GeoPoint;

fn geohash_anchor_path(geohash: &str) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(catalog_geohash_path(geohash)).typed(LinkTypes::GeohashToCatalog)
}

/// Unlike open orders, old
/// catalog entries are *signal*, not noise -- a merchant published a year
/// ago should still show up in "restaurants near me" today, so this anchor
/// is deliberately *not* time-bucketed. The real scale concern here is
/// different: a dense city can legitimately have thousands of real
/// merchants in one cell, and returning all of them in one call doesn't
/// bound payload size or per-call cost. Fixed with pagination instead.
const CATALOG_PAGE_SIZE: usize = 50;
const MENU_ITEM_PAGE_SIZE: usize = 50;

#[derive(Serialize, Deserialize, Debug)]
pub struct PublishCatalogInput {
    pub business_name: String,
    pub location: GeoPoint,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub cuisine_type: String,
    #[serde(default)]
    pub banner_data_uri: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub website: String,
    #[serde(default)]
    pub address_street: String,
    #[serde(default)]
    pub address_city: String,
    #[serde(default)]
    pub address_state: String,
    #[serde(default)]
    pub address_zip: String,
    /// See `MerchantCatalog::weekly_hours`.
    #[serde(default)]
    pub weekly_hours: Vec<OpeningPeriod>,
    /// The merchant's IANA time zone -- the app sends the device's; UTC if
    /// left out.
    #[serde(default = "utc")]
    pub time_zone: String,
    /// The network's default (`handshake_governance::default_prep_minutes`) if
    /// left out.
    #[serde(default)]
    pub prep_minutes: Option<u16>,
    /// The network's default (`handshake_governance::default_delivery_radius_km`)
    /// if left out.
    #[serde(default)]
    pub max_delivery_radius_km: Option<f64>,
}

fn utc() -> String {
    "UTC".into()
}

/// A catalog's stable identity alongside its current content. Everything
/// tied to a store (menu items, promo codes, goodie bags, order queues,
/// reviews) is keyed on its *original* action, while screens need its
/// *latest* state (open right now? current subsidy?) -- and a `Record`'s
/// own hash is only ever one of the two.
#[derive(Serialize, Deserialize, Debug)]
pub struct CatalogView {
    /// The catalog's original action -- the `OwnerToCatalog`/
    /// `GeohashToCatalog` link target, fixed at publish time. Use this as
    /// `catalog_ref`, never the record's own hash, which changes on every
    /// edit (and would orphan everything keyed on the store).
    pub original_action: ActionHash,
    pub record: Record,
}

/// Every store this agent owns, oldest first, via the `OwnerToCatalog`
/// links created at publish time -- deterministic and independent of
/// geohash matching, unlike discovering them through `get_nearby_merchants`
/// (which only works if the caller's current `location` happens to hash to
/// the same cell each store did). One owner running several stores is the
/// normal case, not an edge case -- same as one DoorDash/Uber Eats business
/// login managing several locations -- so everything per-store (menu,
/// promo codes, goodie bags, order queue, reviews, reputation) is keyed by
/// each store's own `original_action`, never by the owner. Creation order
/// is the stable ordering a store switcher wants: a newly added store
/// lands at the end instead of reshuffling the list.
#[hdk_extern]
pub fn list_my_catalogs(_: ()) -> ExternResult<Vec<CatalogView>> {
    let owner = agent_info()?.agent_initial_pubkey;
    let mut links = get_links(LinkQuery::try_new(owner, LinkTypes::OwnerToCatalog)?, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    Ok(resolve_links_to_records_with_original(links)
        .into_iter()
        .map(|(original_action, record)| CatalogView { original_action, record })
        .collect())
}

/// Refuses contact details validation would, saying how to fix them.
fn ensure_contact(email: &str, website: &str) -> ExternResult<()> {
    if email_problem(email).is_some() {
        return Err(guest("That email address doesn't look right. It should look like name@example.com."));
    }
    if website_problem(website).is_some() {
        return Err(guest("That website address doesn't look right. It should start with https://, like https://example.com."));
    }
    Ok(())
}

/// Publishes a new store. Deliberately no "you already have one" guard --
/// an owner adds as many stores as they run (see `list_my_catalogs`).
#[hdk_extern]
pub fn publish_catalog(input: PublishCatalogInput) -> ExternResult<Record> {
    ensure_contact(&input.email, &input.website)?;
    let owner = agent_info()?.agent_initial_pubkey;
    let geohash = handshake_types::encode(input.location, CATALOG_GEOHASH_PRECISION);
    let catalog = MerchantCatalog {
        owner: owner.clone(),
        business_name: input.business_name,
        location: input.location,
        geohash: geohash.clone(),
        is_open: true,
        description: input.description,
        cuisine_type: input.cuisine_type,
        banner_data_uri: input.banner_data_uri,
        phone: input.phone,
        email: input.email,
        website: input.website,
        address_street: input.address_street,
        address_city: input.address_city,
        address_state: input.address_state,
        address_zip: input.address_zip,
        weekly_hours: input.weekly_hours,
        time_zone: input.time_zone,
        prep_minutes: input.prep_minutes.unwrap_or_else(handshake_governance::default_prep_minutes),
        delivery_subsidy_percent: handshake_governance::default_delivery_subsidy_percent(),
        max_delivery_radius_km: input.max_delivery_radius_km.unwrap_or_else(handshake_governance::default_delivery_radius_km),
        dietary_tags: Vec::new(),
        auto_accept_orders: false,
        leave_at_door_max_cents: None,
        min_order_cents: None,
        busy_extra_minutes: 0,
        store_wait_minutes: None,
        tax_rates: Vec::new(),
        prices_include_tax: false,
        tax_registration: String::new(),
    };
    let action_hash = create_entry(&EntryTypes::MerchantCatalog(catalog))?;
    create_link(owner, action_hash.clone(), LinkTypes::OwnerToCatalog, ())?;

    list(&action_hash, &geohash)?;

    written(action_hash)
}

/// Cross-zome read for `dispatch::complete_delivery` (and the equivalent
/// dispute-resolution settlement paths) to look up a merchant's current
/// `delivery_subsidy_percent` at settlement time -- no client previously
/// needed to fetch a single catalog by reference, only lists/pages.
#[hdk_extern]
pub fn get_catalog(catalog_ref: ActionHash) -> ExternResult<Record> {
    resolve_latest(catalog_ref)
}

/// A narrow, purpose-built cross-zome read for `dispatch::complete_delivery`
/// -- returns just the one field settlement needs, rather than having
/// `dispatch_coordinator` partially-decode a `MerchantCatalog` entry it has
/// no Cargo-level type for (coordinator zomes call each other over the
/// zome-call boundary specifically to avoid that kind of coupling).
#[hdk_extern]
pub fn get_delivery_subsidy(catalog_ref: ActionHash) -> ExternResult<u8> {
    let (_, catalog): (_, MerchantCatalog) = resolve_latest_decoded(catalog_ref, "MerchantCatalog")?;
    Ok(catalog.delivery_subsidy_percent)
}

// --- promo codes: a store's own discounts ---

#[cfg(feature = "test-utils")]
mod test_utils {
    use hdk::prelude::*;
    use catalog_integrity::{EntryTypes, LinkTypes, MerchantCatalog};
    handshake_coordinator_support::raw_link_test_externs!(OwnerToCatalog, CatalogToMenuItem, GeohashToCatalog, CatalogToPromoCode, CatalogToBag, BagToClaim, CustomerToClaim, CatalogToLivePromo, CatalogToSuccessor, CatalogToPredecessor, CatalogToImport);

    /// Writes a store's move exactly as given -- what a modified client could.
    #[hdk_extern]
    pub fn create_raw_store_move_for_testing(moved: catalog_integrity::StoreSuccession) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::StoreSuccession(moved))
    }

    /// Writes a goodie-bag claim exactly as given, past the coordinator's
    /// checks -- so a test can prove what validation refuses.
    #[hdk_extern]
    pub fn create_raw_bag_claim_for_testing(claim: catalog_integrity::BagClaim) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::BagClaim(claim))
    }

    /// The anchor a store's listing sits under -- so a test can try forged
    /// listings where real ones go.
    #[hdk_extern]
    pub fn listing_anchor_for_testing(catalog_ref: ActionHash) -> ExternResult<AnyLinkableHash> {
        let (_, catalog): (_, MerchantCatalog) = handshake_coordinator_support::resolve_latest_decoded(catalog_ref, "MerchantCatalog")?;
        Ok(super::geohash_anchor_path(&catalog.geohash)?.path_entry_hash()?.into())
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct RawCatalogUpdate {
        pub original_action: ActionHash,
        pub catalog: MerchantCatalog,
    }

    /// Updates a catalog with exactly the entry given -- what a modified
    /// client could -- so a test can prove who validation lets update one.
    #[hdk_extern]
    pub fn update_raw_catalog_for_testing(input: RawCatalogUpdate) -> ExternResult<ActionHash> {
        update_entry(input.original_action, &EntryTypes::MerchantCatalog(input.catalog))
    }
}

// --- listing a store for customers to find ---
