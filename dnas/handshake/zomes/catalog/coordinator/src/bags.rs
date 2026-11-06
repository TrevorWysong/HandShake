//! Goodie bags: limited-quantity, time-windowed, discounted mystery bags of
//! surplus food (`catalog_types::GoodieBag`). A customer orders one as a
//! line of an ordinary order; its store accepting that order is what sells
//! it, counted against the bag's quantity (`dispatch`'s `bags`).

use handshake_integrity_support::allergens::AllergenFacts;
use catalog_integrity::*;
use hdk::prelude::*;
use handshake_coordinator_support::{decode_or, resolve_latest, resolve_links_to_records_with_original, resolve_version, update_version, written};

use crate::NearbyMerchantsInput;

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateGoodieBagInput {
    pub catalog_ref: ActionHash,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub photo_data_uri: String,
    #[serde(default)]
    pub allergens: Option<AllergenFacts>,
    pub original_value_cents: u64,
    pub price_cents: u64,
    pub quantity_total: u32,
    pub pickup_window_start: Timestamp,
    pub pickup_window_end: Timestamp,
    pub supports_pickup: bool,
    pub supports_delivery: bool,
    pub created_at: Timestamp,
}

#[hdk_extern]
pub fn create_goodie_bag(input: CreateGoodieBagInput) -> ExternResult<Record> {
    let bag = GoodieBag {
        catalog_ref: input.catalog_ref,
        title: input.title,
        description: input.description,
        photo_data_uri: input.photo_data_uri,
        allergens: input.allergens,
        original_value_cents: input.original_value_cents,
        price_cents: input.price_cents,
        quantity_total: input.quantity_total,
        pickup_window_start: input.pickup_window_start,
        pickup_window_end: input.pickup_window_end,
        supports_pickup: input.supports_pickup,
        supports_delivery: input.supports_delivery,
        created_at: input.created_at,
    };
    let catalog_ref = bag.catalog_ref.clone();
    let action_hash = create_entry(&EntryTypes::GoodieBag(bag))?;
    create_link(catalog_ref, action_hash.clone(), LinkTypes::CatalogToBag, ())?;
    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateGoodieBagInput {
    pub original_action: ActionHash,
    pub bag: GoodieBag,
}

#[hdk_extern]
pub fn update_goodie_bag(input: UpdateGoodieBagInput) -> ExternResult<Record> {
    let current = resolve_version(input.original_action)?;
    let updated = update_version(&current, &EntryTypes::GoodieBag(input.bag), LinkTypes::Version)?;
    written(updated)
}

#[hdk_extern]
pub fn get_goodie_bag(bag_ref: ActionHash) -> ExternResult<Record> {
    resolve_latest(bag_ref)
}

/// A bag's stable identity (its original action -- what an order's line
/// names) alongside its latest content. Using the latest record's own
/// action hash as the identity would orphan its orders as soon as the
/// merchant edited it -- the same split `CatalogView` makes.
#[derive(Serialize, Deserialize, Debug)]
pub struct BagView {
    pub original_action: ActionHash,
    pub record: Record,
}

/// Bags listed within the longest a bag may live
/// (`handshake_governance::goodie_bag_max_lifetime`) -- the only
/// ones that can still be live (validation caps a bag's lifetime), so this
/// reads a week of links at most, never a store's whole history.
fn recent_bags(catalog_ref: &ActionHash) -> ExternResult<Vec<(BagView, GoodieBag)>> {
    let mut query = LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToBag)?;
    query.after = Some(Timestamp::from_micros(sys_time()?.as_micros() - bag_lifetime_micros()));
    let links = get_links(query, GetStrategy::default())?;
    Ok(resolve_links_to_records_with_original(links)
        .into_iter()
        .filter_map(|(original_action, record)| {
            let bag = decode_or::<GoodieBag>(&record)?;
            (&bag.catalog_ref == catalog_ref).then_some((BagView { original_action, record }, bag))
        })
        .collect())
}

/// The store's bags that can still be ordered (window not over).
#[hdk_extern]
pub fn list_goodie_bags_for_catalog(catalog_ref: ActionHash) -> ExternResult<Vec<BagView>> {
    let now = sys_time()?;
    Ok(recent_bags(&catalog_ref)?.into_iter().filter(|(_, bag)| bag.pickup_window_end > now).map(|(view, _)| view).collect())
}

#[hdk_extern]
pub fn get_nearby_goodie_bags(input: NearbyMerchantsInput) -> ExternResult<Vec<BagView>> {
    let nearby = crate::get_nearby_merchants(input)?;
    let mut bags = Vec::new();
    for catalog_view in nearby.catalogs {
        bags.extend(list_goodie_bags_for_catalog(catalog_view.original_action)?);
    }
    Ok(bags)
}

/// The longest a goodie bag may stay listed, in microseconds.
fn bag_lifetime_micros() -> i64 {
    handshake_governance::goodie_bag_max_lifetime().as_micros() as i64
}
