//! A store's settings, each changed on its own: open or not, auto-accepting,
//! the door and minimum-order limits, tax, how long it keeps a driver
//! waiting, busy mode, its storefront details and its share of delivery
//! fees.

use super::*;
use handshake_integrity_support::allergens::AllergyPolicy;

#[derive(Serialize, Deserialize, Debug)]
pub struct SetCatalogOpenInput {
    pub original_action: ActionHash,
    pub is_open: bool,
}

#[hdk_extern]
pub fn set_catalog_open(input: SetCatalogOpenInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.is_open = input.is_open;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetAutoAcceptOrdersInput {
    pub original_action: ActionHash,
    pub auto_accept_orders: bool,
    /// Hold customers whose score is below this share for review; `None`
    /// holds none. Left out, it's unchanged.
    #[serde(default)]
    pub hold_below_customer_score: Option<Option<u8>>,
}

/// Turns the store's conductor accepting new orders on its own on or off,
/// and which customers it holds for review -- see
/// `MerchantCatalog::auto_accept_orders`, `hold_below_customer_score`.
#[hdk_extern]
pub fn set_auto_accept_orders(input: SetAutoAcceptOrdersInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.auto_accept_orders = input.auto_accept_orders;
    if let Some(hold) = input.hold_below_customer_score {
        if hold.is_some_and(|percent| percent > 100) {
            return Err(guest("A score to hold below is a share, at most 100%."));
        }
        catalog.hold_below_customer_score = hold;
    }
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetAllergyPolicyInput {
    pub original_action: ActionHash,
    pub allergy_policy: Option<AllergyPolicy>,
}

/// What the store says about allergens across its kitchen, and how it takes a
/// customer's requests -- see `MerchantCatalog::allergy_policy`.
#[hdk_extern]
pub fn set_allergy_policy(input: SetAllergyPolicyInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.allergy_policy = input.allergy_policy;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetLeaveAtDoorLimitInput {
    pub original_action: ActionHash,
    /// `None` for no limit.
    pub max_cents: Option<u64>,
}

/// The most an order may cost to be left at the door -- see
/// `MerchantCatalog::leave_at_door_max_cents`.
#[hdk_extern]
pub fn set_leave_at_door_limit(input: SetLeaveAtDoorLimitInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.leave_at_door_max_cents = input.max_cents;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetMaxDeliveryFeeInput {
    pub original_action: ActionHash,
    pub max_cents: u64,
}

/// The most a delivery fee may be on the store's orders -- see
/// `MerchantCatalog::max_delivery_fee`.
#[hdk_extern]
pub fn set_max_delivery_fee(input: SetMaxDeliveryFeeInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.max_delivery_fee = input.max_cents;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetTipLimitInput {
    pub original_action: ActionHash,
    pub percent: u16,
    pub floor_cents: u64,
}

/// How big a tip may be on the store's deliveries -- see
/// `MerchantCatalog::max_tip_percent`.
#[hdk_extern]
pub fn set_tip_limit(input: SetTipLimitInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.max_tip_percent = input.percent;
    catalog.max_tip_floor = input.floor_cents;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetMinimumOrderInput {
    pub original_action: ActionHash,
    /// `None` for any size.
    pub min_cents: Option<u64>,
}

/// The smallest order the store takes -- see
/// `MerchantCatalog::min_order_cents`.
#[hdk_extern]
pub fn set_minimum_order(input: SetMinimumOrderInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.min_order_cents = input.min_cents;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetTaxSettingsInput {
    pub original_action: ActionHash,
    pub tax_rates: Vec<TaxRate>,
    pub prices_include_tax: bool,
    pub tax_registration: String,
}

/// The sales tax or VAT the store charges -- see `MerchantCatalog::tax_rates`.
/// Orders placed from here on are taxed at these rates; earlier ones keep
/// the rates they were placed under.
#[hdk_extern]
pub fn set_tax_settings(input: SetTaxSettingsInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.tax_rates = input.tax_rates;
    catalog.prices_include_tax = input.prices_include_tax;
    catalog.tax_registration = input.tax_registration.trim().to_string();
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetStoreWaitInput {
    pub original_action: ActionHash,
    /// `None` for the network's.
    pub minutes: Option<u16>,
}

/// How long the store may keep a checked-in driver waiting past an order's
/// ready time -- see `MerchantCatalog::store_wait_minutes`. Orders keep the
/// wait they were placed under.
#[hdk_extern]
pub fn set_store_wait(input: SetStoreWaitInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.store_wait_minutes = input.minutes;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetBusyInput {
    pub original_action: ActionHash,
    /// Minutes to add to the usual prep time; 0 when the rush is over.
    pub extra_minutes: u16,
}

/// The store saying it's busy (or not any more) -- see
/// `MerchantCatalog::busy_extra_minutes`.
#[hdk_extern]
pub fn set_busy(input: SetBusyInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.busy_extra_minutes = input.extra_minutes;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

/// A merchant fills in storefront depth (description, cuisine, hours,
/// banner) incrementally after publishing, not necessarily all at once --
/// this is the one editable surface for everything `publish_catalog` sets
/// besides `business_name`/`location` (changing those would drift the
/// entry's own `geohash` invariant, so they stay immutable after creation).
#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateCatalogDetailsInput {
    pub original_action: ActionHash,
    pub description: String,
    pub cuisine_type: String,
    pub banner_data_uri: String,
    pub phone: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub website: String,
    pub address_street: String,
    #[serde(default)]
    pub address_line2: String,
    pub address_city: String,
    pub address_state: String,
    pub address_zip: String,
    /// See `MerchantCatalog::weekly_hours`.
    pub weekly_hours: Vec<OpeningPeriod>,
    /// The merchant's IANA time zone, from their device.
    pub time_zone: String,
    pub prep_minutes: u16,
    pub max_delivery_radius_km: f64,
}

#[hdk_extern]
pub fn update_catalog_details(input: UpdateCatalogDetailsInput) -> ExternResult<Record> {
    ensure_contact(&input.email, &input.website)?;
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.description = input.description;
    catalog.cuisine_type = input.cuisine_type;
    catalog.banner_data_uri = input.banner_data_uri;
    catalog.phone = input.phone;
    catalog.email = input.email;
    catalog.website = input.website;
    catalog.address_street = input.address_street;
    catalog.address_line2 = input.address_line2;
    catalog.address_city = input.address_city;
    catalog.address_state = input.address_state;
    catalog.address_zip = input.address_zip;
    catalog.weekly_hours = input.weekly_hours;
    catalog.time_zone = input.time_zone;
    catalog.prep_minutes = input.prep_minutes;
    catalog.max_delivery_radius_km = input.max_delivery_radius_km;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetDeliverySubsidyPercentInput {
    pub original_action: ActionHash,
    pub delivery_subsidy_percent: u8,
}

/// The standard delivery-cost-sharing model, not a rare promotion --
/// defaults to 50 (an even
/// split with the customer) at `publish_catalog` time, adjustable here if a
/// merchant needs a different split. A percentage, not a flat amount, so
/// it stays proportional to whatever the winning bid turns out to be.
#[hdk_extern]
pub fn set_delivery_subsidy_percent(input: SetDeliverySubsidyPercentInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.delivery_subsidy_percent = input.delivery_subsidy_percent;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}
