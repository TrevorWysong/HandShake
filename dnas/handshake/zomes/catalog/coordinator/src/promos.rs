//! Promo codes: a store's own discounts, its limits on them, and the codes
//! live for customers to use.

use super::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct CreatePromoCodeInput {
    pub catalog_ref: ActionHash,
    pub code: String,
    pub requirement: PromoRequirement,
    pub reward: PromoReward,
    pub expires_at: Option<Timestamp>,
    #[serde(default)]
    pub auto_apply: bool,
    /// Who may use it, and how often (`catalog_types::PromoLimits`).
    #[serde(default)]
    pub limits: PromoLimits,
}

/// Cross-zome read for `dispatch::request_delivery`'s best-effort "is this
/// code still active" pre-check -- `resolve_latest` (unlike `hdi`'s
/// `must_get_valid_record`, which the deterministic `validate()` side has
/// to use and which is always literal) actually walks to the current
/// state, so this is the one place that question can genuinely be
/// answered. See `dispatch_integrity::validate_new_order`'s own doc
/// comment for why `active` specifically can't be enforced there.
#[hdk_extern]
pub fn get_promo_code(promo_ref: ActionHash) -> ExternResult<Record> {
    resolve_latest(promo_ref)
}

#[hdk_extern]
pub fn create_promo_code(input: CreatePromoCodeInput) -> ExternResult<Record> {
    let promo = PromoCode {
        catalog_ref: input.catalog_ref.clone(),
        code: input.code,
        requirement: input.requirement,
        reward: input.reward,
        active: true,
        expires_at: input.expires_at,
        created_at: sys_time()?,
        auto_apply: input.auto_apply,
        limits: input.limits,
    };
    if let Some(problem) = promo.limits.problem() {
        return Err(guest(problem));
    }
    let action_hash = create_entry(&EntryTypes::PromoCode(promo))?;
    create_link(input.catalog_ref.clone(), action_hash.clone(), LinkTypes::CatalogToPromoCode, ())?;
    create_link(input.catalog_ref, action_hash.clone(), LinkTypes::CatalogToLivePromo, ())?;
    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetPromoCodeActiveInput {
    pub original_action: ActionHash,
    pub active: bool,
}

#[hdk_extern]
pub fn set_promo_code_active(input: SetPromoCodeActiveInput) -> ExternResult<Record> {
    let (current, mut promo): (_, PromoCode) = resolve_version_decoded(input.original_action.clone(), "PromoCode")?;
    let catalog_ref = promo.catalog_ref.clone();
    promo.active = input.active;
    let updated = update_version(&current, &EntryTypes::PromoCode(promo), LinkTypes::Version)?;
    let target: AnyLinkableHash = input.original_action.clone().into();
    let live_links: Vec<Link> = get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToLivePromo)?, GetStrategy::default())?
        .into_iter()
        .filter(|link| link.target == target)
        .collect();
    if input.active && live_links.is_empty() {
        create_link(catalog_ref, input.original_action, LinkTypes::CatalogToLivePromo, ())?;
    } else if !input.active {
        for link in live_links {
            delete_link(link.create_link_hash, GetOptions::default())?;
        }
    }
    written(updated)
}

/// A promo code's stable identity (what orders and `set_promo_code_active`
/// take) alongside its latest state -- see `CatalogView`.
#[derive(Serialize, Deserialize, Debug)]
pub struct PromoView {
    pub original_action: ActionHash,
    pub record: Record,
}

pub(crate) fn promo_views(catalog_ref: &ActionHash, links: Vec<Link>) -> Vec<PromoView> {
    resolve_links_to_records_with_original(links)
        .into_iter()
        .filter(|(_, record)| decode_or::<PromoCode>(record).is_some_and(|promo| &promo.catalog_ref == catalog_ref))
        .map(|(original_action, record)| PromoView { original_action, record })
        .collect()
}

/// The codes a customer can use at this store right now (active, not
/// expired) -- what checkout matches a typed code against and picks
/// auto-apply deals from. Reads only the live index, so its cost is the
/// store's current deals, not every code it ever ran.
#[hdk_extern]
pub fn list_live_promo_codes(catalog_ref: ActionHash) -> ExternResult<Vec<PromoView>> {
    let now = sys_time()?;
    let links = get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToLivePromo)?, GetStrategy::default())?;
    Ok(promo_views(&catalog_ref, links)
        .into_iter()
        .filter(|view| decode_or::<PromoCode>(&view.record).is_some_and(|promo| promo.active && promo.expires_at.is_none_or(|expires| expires > now)))
        .collect())
}

pub(crate) const PROMO_PAGE_SIZE: usize = 25;

#[derive(Serialize, Deserialize, Debug)]
pub struct ListPromoCodesInput {
    pub catalog_ref: ActionHash,
    /// Page cursor -- the previous page's `next_before`. `None` starts from
    /// the newest code.
    pub before: Option<Timestamp>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PromoCodesPage {
    pub promo_codes: Vec<PromoView>,
    pub next_before: Option<Timestamp>,
}

/// Every code the store has created, active or not, newest first -- the
/// merchant's management list.
#[hdk_extern]
pub fn list_promo_codes_for_catalog(input: ListPromoCodesInput) -> ExternResult<PromoCodesPage> {
    let mut query = LinkQuery::try_new(input.catalog_ref.clone(), LinkTypes::CatalogToPromoCode)?;
    query.before = input.before;
    let (links, next_before) = handshake_coordinator_support::links::newest_first_page(query, PROMO_PAGE_SIZE)?;
    Ok(PromoCodesPage { promo_codes: promo_views(&input.catalog_ref, links), next_before })
}
