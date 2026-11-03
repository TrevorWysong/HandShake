//! Link validation. A store's menu, promo codes and goodie bags are all read
//! by walking links from the store (or its anchors); these rules make sure
//! each link points at an entry that really belongs where it's linked --
//! otherwise anyone could, say, inject another store's items into a menu.

use crate::*;
use handshake_integrity_support::{decode, invalid, linked_record, path_hash, require, valid};

/// The anchor a store is listed under, for the geohash cell it's in --
/// mirrored by the coordinator's `geohash_anchor_path`.
pub fn catalog_geohash_path(geohash: &str) -> String {
    format!("catalog_geohash.{geohash}")
}

pub fn validate_create_link(link_type: LinkTypes, link: &TypedAction<CreateLinkData>) -> ExternResult<ValidateCallbackResult> {
    let (base, target, author) = (&link.base_address, &link.target_address, link.author());
    // Anchors are computed, never walked: every catalog link targets a
    // record, so nobody can clutter an anchor with links to nowhere.
    let Some(record) = linked_record(target)? else { return invalid("catalog links must target a record") };
    let entry_author = record.action().author();
    match link_type {
        // Validated as a version (`validate`).
        LinkTypes::Version => invalid("a version link is validated as one"),
        LinkTypes::OwnerToCatalog => {
            let Some(catalog) = decode::<MerchantCatalog>(&record) else { return invalid("target is not a MerchantCatalog") };
            require(author == &catalog.owner && base == &AnyLinkableHash::from(catalog.owner.clone()), "a store is linked from its owner, by its owner")
        }
        LinkTypes::GeohashToCatalog => validate_listing(link, &record),
        LinkTypes::CatalogToImport => {
            let Some(import) = decode::<StoreImport>(&record) else { return invalid("target is not a store's import") };
            require(author == entry_author && base == &AnyLinkableHash::from(import.to), "a store's import is linked from the store, by its author")
        }
        LinkTypes::CatalogToSuccessor | LinkTypes::CatalogToPredecessor => {
            let Some(moved) = decode::<StoreSuccession>(&record) else { return invalid("target is not a store's move") };
            let expected = if link_type == LinkTypes::CatalogToSuccessor { moved.from } else { moved.to };
            require(author == entry_author && base == &AnyLinkableHash::from(expected), "a store's move is linked from its stores, by its author")
        }
        LinkTypes::CatalogToMenuItem => {
            let Some(item) = decode::<MenuItem>(&record) else { return invalid("target is not a MenuItem") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(item.catalog_ref),
                "a menu item may only be linked under its own catalog, by its author",
            )
        }
        LinkTypes::CatalogToModifierGroup => {
            let Some(group) = decode::<ModifierGroup>(&record) else { return invalid("target is not a ModifierGroup") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(group.catalog_ref) && matches!(record.action().data, ActionData::Create(_)),
                "a choice group is linked under its own catalog, by its author, by its original action",
            )
        }
        LinkTypes::CatalogToPromoCode => {
            let Some(promo) = decode::<PromoCode>(&record) else { return invalid("target is not a PromoCode") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(promo.catalog_ref),
                "a promo code may only be linked under its own catalog, by its author",
            )
        }
        LinkTypes::CatalogToLivePromo => {
            let Some(promo) = decode::<PromoCode>(&record) else { return invalid("target is not a PromoCode") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(promo.catalog_ref),
                "a promo code may only be listed as live under its own catalog, by its author",
            )
        }
        LinkTypes::CatalogToBag => {
            let Some(bag) = decode::<GoodieBag>(&record) else { return invalid("target is not a GoodieBag") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(bag.catalog_ref),
                "a goodie bag may only be linked under its own catalog, by its author",
            )
        }
    }
}

/// Only whoever created a link may remove it.
pub fn validate_delete_link(original_author: &AgentPubKey, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if original_author == author {
        valid()
    } else {
        invalid("only a link's own author may delete it")
    }
}

/// A store's listing for customers to find: by its owner, under its own
/// area's anchor, to its original action. Nothing stops an owner listing a
/// store twice but the reads, which show it once; a listing's only cost is
/// the store behind it (`MAX_STORES_PER_OWNER`).
fn validate_listing(link: &TypedAction<CreateLinkData>, record: &Record) -> ExternResult<ValidateCallbackResult> {
    let Some(catalog) = decode::<MerchantCatalog>(record) else { return invalid("a listing is of a store") };
    let own = matches!(record.action().data, ActionData::Create(_)) && link.author() == &catalog.owner && link.base_address == path_hash(catalog_geohash_path(&catalog.geohash))? && link.tag.0.is_empty();
    require(own, "a store is listed by its owner, under its own area, by its original action")
}
