//! Coordinator zome for agent identity: `Profile` (roles, display name) and
//! `ProviderCredential` (a driver's vehicle, kept on their own device).

use hdk::prelude::*;
use handshake_integrity_support::allergens::AllergySet;
use profiles_integrity::*;
use handshake_coordinator_support::chain::mine;
use handshake_coordinator_support::{guest, open, open_padded, seal_padded, resolve_latest, resolve_links_to_records_with_original, resolve_version, seal, update_version, written};

/// A profile as the person's own client sends it: the phone in the clear,
/// sealed before it's stored (`Profile::sealed_phone`).
#[derive(Serialize, Deserialize, Debug)]
pub struct ProfileInput {
    /// The person's name. Always kept sealed to themselves; published as
    /// the profile's `display_name` only for a store or a driver (see
    /// `Profile::display_name`).
    pub display_name: String,
    pub roles: Vec<RoleTag>,
    pub created_at: Timestamp,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub avatar_data_uri: String,
    #[serde(default)]
    pub phone: String,
}

impl ProfileInput {
    fn into_profile(self) -> ExternResult<Profile> {
        let me = agent_info()?.agent_initial_pubkey;
        let phone = self.phone.trim();
        let name = self.display_name.trim().to_string();
        let mut profile = Profile {
            sealed_phone: if phone.is_empty() { None } else { Some(seal(&me, &phone.to_string())?) },
            sealed_name: if name.is_empty() { None } else { Some(seal(&me, &name)?) },
            display_name: String::new(),
            roles: self.roles,
            created_at: self.created_at,
            bio: self.bio,
            avatar_data_uri: self.avatar_data_uri,
        };
        if profile.is_public() {
            profile.display_name = name;
        }
        Ok(profile)
    }
}

#[hdk_extern]
pub fn create_profile(input: ProfileInput) -> ExternResult<Record> {
    let action_hash = create_entry(&EntryTypes::Profile(input.into_profile()?))?;
    let agent = agent_info()?.agent_initial_pubkey;
    create_link(agent, action_hash.clone(), LinkTypes::AgentToProfile, ())?;
    let record = written(action_hash)?;
    // Every account holds a sealed list from the start, so holding one says
    // nothing about having anything on it.
    if allergies_link()?.is_none() {
        save_my_allergies(AllergySet::default())?;
    }
    Ok(record)
}

#[hdk_extern]
pub fn get_profile_for_agent(agent: AgentPubKey) -> ExternResult<Option<Record>> {
    let links = get_links(
        LinkQuery::try_new(agent, LinkTypes::AgentToProfile)?,
        GetStrategy::default(),
    )?;
    let Some(link) = links.into_iter().max_by_key(|l| l.timestamp) else {
        return Ok(None);
    };
    let action_hash = link
        .target
        .into_action_hash()
        .ok_or(guest("malformed profile link target"))?;
    resolve_latest(action_hash).map(Some)
}

#[hdk_extern]
pub fn update_profile(input: UpdateProfileInput) -> ExternResult<Record> {
    let current = resolve_version(input.original_action)?;
    let updated_hash = update_version(&current, &EntryTypes::Profile(input.updated_profile.into_profile()?), LinkTypes::Version)?;
    let record = written(updated_hash)?;
    Ok(record)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateProfileInput {
    pub original_action: ActionHash,
    pub updated_profile: ProfileInput,
}

/// The caller's own name, opened from their profile -- falling back to its
/// public name for a profile written before names were sealed.
#[hdk_extern]
pub fn get_my_name(_: ()) -> ExternResult<Option<String>> {
    let me = agent_info()?.agent_initial_pubkey;
    let Some(record) = get_profile_for_agent(me.clone())? else { return Ok(None) };
    let Some(profile) = record.entry().to_app_option::<Profile>().map_err(|e| wasm_error!(e))? else { return Ok(None) };
    match profile.sealed_name {
        Some(sealed) => open(&me, &sealed),
        None => Ok(Some(profile.display_name).filter(|name| !name.is_empty())),
    }
}

/// The caller's own phone number, opened from their profile.
#[hdk_extern]
pub fn get_my_phone(_: ()) -> ExternResult<Option<String>> {
    let me = agent_info()?.agent_initial_pubkey;
    let Some(record) = get_profile_for_agent(me.clone())? else { return Ok(None) };
    match record.entry().to_app_option::<Profile>().map_err(|e| wasm_error!(e))?.and_then(|p| p.sealed_phone) {
        Some(sealed) => open(&me, &sealed),
        None => Ok(None),
    }
}

/// Saves the caller's vehicle, on this device only -- the latest replaces
/// any before it. Nobody else reads it: it goes, sealed, only to the
/// customer of an order they've committed to (`dispatch::share_vehicle`).
#[hdk_extern]
pub fn register_provider_credential(credential: ProviderCredential) -> ExternResult<Record> {
    written(create_entry(&EntryTypes::ProviderCredential(credential))?)
}

/// The caller's vehicle, as they last saved it.
#[hdk_extern]
pub fn get_my_vehicle(_: ()) -> ExternResult<Option<Record>> {
    let types = [EntryType::try_from(UnitEntryTypes::ProviderCredential)?];
    mine(&types).latest()
}

// --- favorite restaurants --- a customer's own saved-restaurant list.
// Personal, zero-multi-party-trust data (nobody else ever needs to query
// "who favorited this catalog") -- so unlike the discovery anchors
// elsewhere in this app, there's no hot-shared-anchor concern here at all:
// the link base is this one agent's own pubkey, and the set it bounds is
// "how many restaurants this one person has favorited," not anything that
// grows with total app usage. No entry type, no pagination -- a personal
// list is realistically dozens of items at most, same bounded-list
// reasoning already applied to a merchant's promo codes.

#[hdk_extern]
pub fn add_favorite(catalog_ref: ActionHash) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    create_link(me, catalog_ref, LinkTypes::AgentToFavorite, ())?;
    Ok(())
}

/// Finds and deletes the specific link for this `catalog_ref` among the
/// caller's own favorite links -- `delete_link` needs the *create* action's
/// own hash, not the target, so this always does a lookup first rather than
/// trusting a client-cached link hash that could be stale.
#[hdk_extern]
pub fn remove_favorite(catalog_ref: ActionHash) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(me, LinkTypes::AgentToFavorite)?, GetStrategy::default())?;
    for link in links {
        if link.target.into_action_hash().as_ref() == Some(&catalog_ref) {
            delete_link(link.create_link_hash, GetOptions::default())?;
        }
    }
    Ok(())
}

#[hdk_extern]
pub fn list_favorites(_: ()) -> ExternResult<Vec<ActionHash>> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(me, LinkTypes::AgentToFavorite)?, GetStrategy::default())?;
    Ok(links.into_iter().filter_map(|l| l.target.into_action_hash()).collect())
}

// --- saved addresses -- a customer's own named address book ("Home",
// "Work", ...), the DoorDash/UberEats-style "deliver to" switcher. See
// `SavedAddress`'s own doc comment for why this lives on-chain rather
// than in `localStorage` the way `location`'s own ephemeral "which one am
// I using right now" pointer does.

/// Seals an address for its owner, after checking what validation can't
/// (the content is sealed by the time it gets there).
fn sealed_address(details: &AddressDetails) -> ExternResult<SavedAddress> {
    if details.label.trim().is_empty() {
        return Err(guest("Give the address a name, like “Home”."));
    }
    if details.line2.chars().count() > handshake_integrity_support::limits::MAX_ADDRESS_LINE2_CHARS {
        return Err(guest("That second address line is too long."));
    }
    let me = agent_info()?.agent_initial_pubkey;
    Ok(SavedAddress { sealed: seal(&me, details)?, created_at: sys_time()? })
}

#[hdk_extern]
pub fn save_address(address: AddressDetails) -> ExternResult<Record> {
    let me = agent_info()?.agent_initial_pubkey;
    let action_hash = create_entry(&EntryTypes::SavedAddress(sealed_address(&address)?))?;
    create_link(me, action_hash.clone(), LinkTypes::OwnerToSavedAddress, ())?;
    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateSavedAddressInput {
    pub original_action: ActionHash,
    pub address: AddressDetails,
}

#[hdk_extern]
pub fn update_saved_address(input: UpdateSavedAddressInput) -> ExternResult<Record> {
    let current = resolve_version(input.original_action)?;
    let updated = update_version(&current, &EntryTypes::SavedAddress(sealed_address(&input.address)?), LinkTypes::Version)?;
    written(updated)
}

/// Finds and deletes the specific link for this `original_action` among
/// the caller's own saved-address links -- same "always look up the real
/// create-action hash, never trust a client-cached one" reasoning as
/// `remove_favorite`. The entry itself stays on the DHT (nothing on
/// Holochain can truly be erased); this just makes it stop showing up in
/// `list_my_addresses`.
#[hdk_extern]
pub fn delete_saved_address(original_action: ActionHash) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(me, LinkTypes::OwnerToSavedAddress)?, GetStrategy::default())?;
    for link in links {
        if link.target.into_action_hash().as_ref() == Some(&original_action) {
            delete_link(link.create_link_hash, GetOptions::default())?;
        }
    }
    Ok(())
}

/// The caller's own allergies, kept sealed to them: what their app warns them
/// about, and offers to tell a store at checkout. The network only ever holds
/// a box of one size.
#[hdk_extern]
pub fn save_my_allergies(allergies: AllergySet) -> ExternResult<()> {
    if let Some(problem) = allergies.problem() {
        return Err(guest(problem));
    }
    let me = agent_info()?.agent_initial_pubkey;
    let entry = SealedAllergies { sealed: seal_padded(&me, &allergies)? };
    match allergies_link()? {
        Some(original) => {
            let current = resolve_version(original)?;
            update_version(&current, &EntryTypes::SealedAllergies(entry), LinkTypes::Version)?;
        }
        None => {
            let action_hash = create_entry(&EntryTypes::SealedAllergies(entry))?;
            create_link(me, action_hash, LinkTypes::OwnerToAllergies, ())?;
        }
    }
    Ok(())
}

/// The caller's sealed list, by its original action.
fn allergies_link() -> ExternResult<Option<ActionHash>> {
    let me = agent_info()?.agent_initial_pubkey;
    Ok(get_links(LinkQuery::try_new(me, LinkTypes::OwnerToAllergies)?, GetStrategy::default())?.into_iter().next().and_then(|link| link.target.into_action_hash()))
}

/// The caller's own allergies -- none, if they've never said any.
#[hdk_extern]
pub fn my_allergies(_: ()) -> ExternResult<AllergySet> {
    let me = agent_info()?.agent_initial_pubkey;
    let Some(original) = allergies_link()? else { return Ok(AllergySet::default()) };
    let record = resolve_latest(original)?;
    let Some(entry) = record.entry().to_app_option::<SealedAllergies>().ok().flatten() else { return Ok(AllergySet::default()) };
    Ok(open_padded(&me, &entry.sealed)?.unwrap_or_default())
}

/// Pairs each saved address's stable identity with its current content --
/// same shape (and same reason) as catalog's own `CatalogView`: the
/// `OwnerToSavedAddress` link target is fixed forever at `save_address`
/// time, so a caller editing/deleting a saved address later needs that
/// original hash, never whatever a resolved-to-latest `Record`'s own
/// action hash happens to be.
#[derive(Serialize, Deserialize, Debug)]
pub struct SavedAddressView {
    pub original_action: ActionHash,
    /// The address, opened for its owner.
    pub address: AddressDetails,
}

#[hdk_extern]
pub fn list_my_addresses(_: ()) -> ExternResult<Vec<SavedAddressView>> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(me.clone(), LinkTypes::OwnerToSavedAddress)?, GetStrategy::default())?;
    let mut views = Vec::new();
    for (original_action, record) in resolve_links_to_records_with_original(links) {
        let Some(saved) = record.entry().to_app_option::<SavedAddress>().ok().flatten() else { continue };
        if let Some(address) = open(&me, &saved.sealed)? {
            views.push(SavedAddressView { original_action, address });
        }
    }
    Ok(views)
}

/// How long the caller's sealed list is, for a test to prove it's held from
/// the start and stays one size.
#[cfg(feature = "test-utils")]
#[hdk_extern]
pub fn my_sealed_allergies_length_for_testing(_: ()) -> ExternResult<Option<usize>> {
    let Some(original) = allergies_link()? else { return Ok(None) };
    let record = resolve_latest(original)?;
    record.entry().to_app_option::<SealedAllergies>().ok().flatten().map(|entry| ExternIO::encode(&entry.sealed).map(|io| io.0.len())).transpose().map_err(|e| wasm_error!(WasmErrorInner::Guest(e.to_string())))
}

#[cfg(feature = "test-utils")]
mod test_utils {
    use hdk::prelude::*;
    use profiles_integrity::LinkTypes;
    handshake_coordinator_support::raw_link_test_externs!(AgentToProfile, AgentToFavorite, OwnerToSavedAddress);

    #[derive(Serialize, Deserialize, Debug)]
    pub struct PadInput {
        /// A store to favorite -- any valid catalog.
        pub catalog: ActionHash,
        pub count: u32,
    }

    /// Lengthens the caller's chain by `count` cheap actions (favorite
    /// links), for benchmarks of how validation scales with a chain's
    /// length (tests/tryorama/bench).
    #[hdk_extern]
    pub fn pad_chain_for_testing(input: PadInput) -> ExternResult<()> {
        let me = agent_info()?.agent_initial_pubkey;
        for _ in 0..input.count {
            create_link(me.clone(), input.catalog.clone(), LinkTypes::AgentToFavorite, ())?;
        }
        Ok(())
    }
}
