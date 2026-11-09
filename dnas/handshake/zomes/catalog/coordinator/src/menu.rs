//! A store's menu: its items, added and changed by its owner, and read a
//! page at a time -- with the store's dietary tags kept as their union.

use super::*;

/// Recomputes `MerchantCatalog.dietary_tags` as the sorted, deduplicated
/// union of every one of this catalog's menu items' own `dietary_tags` (its
/// most-carried, past `MAX_DIETARY_TAGS`) --
/// called after any menu-item create/update so the denormalized field
/// never drifts from the real per-item data. Walks every page rather than
/// just the first: a merchant's menu is realistically a few dozen items at
/// most (this is a write-time-only cost, paid on menu edits, not on every
/// browse read -- see `MerchantCatalog.dietary_tags`'s own doc comment for
/// why that tradeoff is the right one here), but silently truncating at one
/// page would mean an item on page 2 could never contribute its tags.
pub(crate) fn recompute_dietary_tags(catalog_ref: &ActionHash) -> ExternResult<()> {
    let mut tags: Vec<String> = Vec::new();
    // How many items carry each tag -- past the most a store may list, its
    // most-carried are kept: a store whose items name more than that between
    // them still lists, and can still change its menu.
    let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let mut after = None;
    loop {
        let page = list_menu_items(ListMenuItemsInput { catalog_ref: catalog_ref.clone(), after })?;
        for view in &page.items {
            if let Ok(Some(item)) = view.record.entry().to_app_option::<MenuItem>() {
                let mut own = item.dietary_tags;
                own.sort();
                own.dedup();
                for tag in own {
                    *counts.entry(tag).or_default() += 1;
                }
            }
        }
        after = page.next_after;
        if after.is_none() {
            break;
        }
    }
    let mut ranked: Vec<(String, usize)> = counts.into_iter().collect();
    ranked.sort_by(|(a, an), (b, bn)| bn.cmp(an).then_with(|| a.cmp(b)));
    tags.extend(ranked.into_iter().take(handshake_integrity_support::limits::MAX_DIETARY_TAGS).map(|(tag, _)| tag));
    tags.sort();

    let (catalog_record, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(catalog_ref.clone(), "MerchantCatalog")?;
    if catalog.dietary_tags != tags {
        catalog.dietary_tags = tags;
        update_version(&catalog_record, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    }
    Ok(())
}

#[hdk_extern]
pub fn add_menu_item(item: MenuItem) -> ExternResult<Record> {
    let catalog_ref = item.catalog_ref.clone();
    let action_hash = create_entry(&EntryTypes::MenuItem(item.clone()))?;
    create_link(catalog_ref.clone(), action_hash.clone(), LinkTypes::CatalogToMenuItem, ())?;
    recompute_dietary_tags(&catalog_ref)?;
    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateMenuItemInput {
    pub original_action: ActionHash,
    pub item: MenuItem,
}

#[hdk_extern]
pub fn update_menu_item(input: UpdateMenuItemInput) -> ExternResult<Record> {
    // Built on the caller's own latest version, which this device always
    // has: building on an older one would fork the item's history.
    let current = match my_current_version(input.original_action.clone())? {
        Some(current) => current,
        None => resolve_version(input.original_action)?,
    };
    let catalog_ref = input.item.catalog_ref.clone();
    let updated = update_version(&current, &EntryTypes::MenuItem(input.item), LinkTypes::Version)?;
    recompute_dietary_tags(&catalog_ref)?;
    written(updated)
}

/// Takes one of the caller's items off their menu: marked sold out -- so an
/// order a modified app still prices from it is refused when the store
/// answers (`dispatch::pricing::sold_out_item`) -- and no longer listed.
/// Orders that had it keep it, and its reviews stay its own.
#[hdk_extern]
pub fn remove_menu_item(original_action: ActionHash) -> ExternResult<()> {
    let current = my_current_version(original_action.clone())?.ok_or(guest("Only its store's owner can remove an item."))?;
    let mut item = decode_or::<MenuItem>(&current.record).ok_or(guest("That isn't a menu item."))?;
    let catalog_ref = item.catalog_ref.clone();
    if item.available {
        item.available = false;
        update_version(&current, &EntryTypes::MenuItem(item), LinkTypes::Version)?;
    }
    let me = agent_info()?.agent_initial_pubkey;
    let target = AnyLinkableHash::from(original_action);
    for link in get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToMenuItem)?.author(me), GetStrategy::Local)? {
        if link.target == target {
            delete_link(link.create_link_hash, GetOptions::default())?;
        }
    }
    recompute_dietary_tags(&catalog_ref)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ListMenuItemsInput {
    pub catalog_ref: ActionHash,
    /// Page cursor -- pass back the previous call's `next_after` to continue.
    /// `None` starts from the beginning.
    pub after: Option<Timestamp>,
}

/// A menu item's stable identity (its original action -- what orders,
/// carts, promos and item reviews reference) alongside its latest content.
/// The latest record's own hash changes on every edit, even toggling it
/// sold out, so it can't be the identity -- see `CatalogView`.
#[derive(Serialize, Deserialize, Debug)]
pub struct MenuItemView {
    pub original_action: ActionHash,
    pub record: Record,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MenuItemsPage {
    pub items: Vec<MenuItemView>,
    pub next_after: Option<Timestamp>,
}

#[hdk_extern]
pub fn list_menu_items(input: ListMenuItemsInput) -> ExternResult<MenuItemsPage> {
    let mut query = LinkQuery::try_new(input.catalog_ref.clone(), LinkTypes::CatalogToMenuItem)?;
    query.after = input.after;
    let mut links = get_links(query, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    let next_after = if links.len() > MENU_ITEM_PAGE_SIZE {
        Some(next_page_cursor(links[MENU_ITEM_PAGE_SIZE - 1].timestamp))
    } else {
        None
    };
    links.truncate(MENU_ITEM_PAGE_SIZE);
    // Link validation already guarantees this; checking again keeps a menu
    // honest even if that guarantee ever regressed.
    let items = resolve_links_to_records_with_original(links)
        .into_iter()
        .filter(|(_, record)| decode_or::<MenuItem>(record).is_some_and(|item| item.catalog_ref == input.catalog_ref))
        .map(|(original_action, record)| MenuItemView { original_action, record })
        .collect();
    Ok(MenuItemsPage { items, next_after })
}
