//! Checks both order verticals run on a new order: its price, its goodie
//! bags, and its promo code.
//!
//! A promo can be updated after creation (`PromoCode.active`), and
//! `must_get_valid_record` only ever returns a record as created --
//! validation can't ask what another entry's *current* state is. So what's
//! enforced here is everything fixed at creation; "is this code still
//! active" is a coordinator pre-check, and whether a bag is still left is
//! the store's to count as it accepts the order.

use super::*;
use catalog_types::{order_tax, order_total, total_with_tax, GoodieBag, MenuItem, PromoRequirement, PromoReward, TaxableLine};
use dispatch_types::LinePricer;
use handshake_integrity_support::limits::{MAX_LINE_QUANTITY, MAX_ORDER_CHOICES, MAX_ORDER_LINES};
use handshake_integrity_support::{decode, original_creation};
use std::collections::BTreeSet;

/// The parts of a new order its price depends on, from either order type.
pub(crate) struct OrderPricing<'a> {
    pub requester: &'a AgentPubKey,
    pub catalog_ref: &'a ActionHash,
    pub lines: &'a [OrderLine],
    pub order_total: u64,
    pub promo_code_ref: Option<&'a ActionHash>,
    pub loyalty_proof: &'a [ActionHash],
    /// The rewards program it joins, and any reward it redeems.
    pub rewards: Option<&'a OrderRewards>,
    /// The customer's action before the order: where the walk proving each
    /// redemption pays for one order starts.
    pub prev_action: Option<&'a ActionHash>,
    /// Whether it's a delivery scheduled for later.
    pub scheduled: bool,
    pub placed_at: Timestamp,
    /// The store as it stood when the order was placed (the version it
    /// cites): its minimum order and its tax rates.
    pub store: &'a MerchantCatalog,
    pub tax_cents: u64,
    /// Whether it's a delivery (a pickup otherwise).
    pub delivery: bool,
    /// The customer's confirmation of their age (a pickup's `age_confirmed`).
    pub age_confirmed: bool,
}

/// The store version an order cites (`catalog_version`) -- the terms it
/// was placed under -- or why it can't be: it must be a version of the
/// order's own store.
pub(crate) fn store_version(catalog_ref: &ActionHash, catalog_version: &ActionHash) -> ExternResult<Result<MerchantCatalog, String>> {
    if &original_creation(catalog_version.clone())? != catalog_ref {
        return Ok(Err("catalog_version must be a version of the order's own store".into()));
    }
    Ok(decode::<MerchantCatalog>(&must_get_valid_record(catalog_version.clone())?).ok_or_else(|| "catalog_version must be a store".into()))
}

/// Where an open delivery is listed for drivers (`OpenOrderGeohashAnchor`):
/// its store's cell, as of the store version the order cites -- or why that
/// can't be read.
pub fn open_order_cell(order: &DeliveryOrder) -> ExternResult<Result<String, String>> {
    Ok(store_version(&order.catalog_ref, &order.catalog_version)?.map(|store| store.geohash.chars().take(OPEN_ORDER_PRECISION).collect()))
}

/// `order_total` must be exactly what the order's lines cost at the item
/// versions they name, less any promo discount, plus the store's tax when
/// it adds it -- and `tax_cents` exactly that tax, at the rates of the
/// store version the order cites -- computed with the same pricing the
/// coordinator uses (`catalog_types::pricing`), so no client can pay a
/// store a different amount than its menu says, nor misstate its tax.
///
/// What this can't know is whether a named version is the item's *latest*
/// one: validation only sees records as they were. The honest coordinator
/// always prices at the latest version, and the store sees which version
/// each line was priced at before confirming the order.
pub(crate) fn check_pricing(order: OrderPricing<'_>) -> ExternResult<Option<String>> {
    if order.lines.is_empty() || order.lines.len() > MAX_ORDER_LINES {
        return Ok(Some(format!("an order has between 1 and {MAX_ORDER_LINES} lines")));
    }
    if order.lines.iter().any(|line| line.quantity == 0 || line.quantity > MAX_LINE_QUANTITY) {
        return Ok(Some(format!("every line has between one and {MAX_LINE_QUANTITY} units")));
    }
    // The same item with the same choices is one line, with its quantity.
    let choices: usize = order.lines.iter().map(|line| catalog_types::choice_count(&line.selections)).sum();
    if choices > MAX_ORDER_CHOICES {
        return Ok(Some(format!("an order chooses at most {MAX_ORDER_CHOICES} options across its lines")));
    }
    let repeated = order.lines.iter().enumerate().any(|(i, line)| order.lines[..i].iter().any(|l| l.item_ref == line.item_ref && l.selections == line.selections));
    if repeated {
        return Ok(Some("the same item with the same choices is one line".into()));
    }

    let reward = match check_rewards(&order)? {
        Ok(reward) => reward,
        Err(reason) => return Ok(Some(reason)),
    };
    if reward.is_some() && order.promo_code_ref.is_some() {
        return Ok(Some("a reward takes the place of any promo".into()));
    }

    // The menu's lines, priced with their choices; the goodie bags', at
    // each bag's own price.
    let mut priced = Vec::with_capacity(order.lines.len());
    let mut categories = Vec::with_capacity(order.lines.len());
    let mut bags: Vec<(&ActionHash, GoodieBag)> = Vec::new();
    let mut age_restricted = false;
    let mut pricer = LinePricer::default();
    for line in order.lines {
        if original_creation(line.priced_version.clone())? != line.item_ref {
            return Ok(Some("a line's priced version must be a version of its own item".into()));
        }
        let record = must_get_valid_record(line.priced_version.clone())?;
        if let Some(bag) = decode::<GoodieBag>(&record) {
            if line.on_sale {
                return Ok(Some("a goodie bag has no sale to claim".into()));
            }
            if let Some(reason) = bag_line_problem(&order, line, &bag) {
                return Ok(Some(reason));
            }
            bags.push((&line.item_ref, bag));
            continue;
        }
        let Some(item) = decode::<MenuItem>(&record) else {
            return Ok(Some("a line must be priced from a MenuItem or a GoodieBag".into()));
        };
        if &item.catalog_ref != order.catalog_ref {
            return Ok(Some("every item must be on this store's menu".into()));
        }
        if line.on_sale {
            let tolerance = handshake_governance::clock_tolerance().as_micros() as i64;
            if !item.sale.as_ref().is_some_and(|sale| sale.within_dates(order.placed_at.as_micros(), tolerance)) {
                return Ok(Some("a line can only claim a sale its item had running".into()));
            }
        }
        match pricer.priced_line(line.item_ref.clone(), &item.as_sold(line.on_sale), &line.selections, line.quantity)? {
            Ok(priced_line) => priced.push(priced_line),
            Err(reason) => return Ok(Some(reason)),
        }
        categories.push(item.tax_category);
        age_restricted |= item.age_restricted;
    }
    if age_restricted {
        if let Some(problem) = age_restriction_problem(&order) {
            return Ok(Some(problem));
        }
    }
    if !bags.is_empty() {
        if let Some(reason) = check_bags_once(&order, &bags)? {
            return Ok(Some(reason));
        }
    }
    // The store's minimum, and any promo or reward, are the menu's: goodie
    // bags are already discounted.
    if priced.is_empty() && (order.promo_code_ref.is_some() || reward.is_some()) {
        return Ok(Some("a promo or reward applies to menu items, not goodie bags".into()));
    }
    if let (Some(min), false) = (order.store.min_order_cents, priced.is_empty()) {
        if catalog_types::subtotal(&priced) < min {
            return Ok(Some("the order is below the store's minimum".into()));
        }
    }

    let promo = match order.promo_code_ref {
        Some(promo_ref) => {
            if let Some(reason) = check_promo_code(promo_ref, order.catalog_ref, order.placed_at)? {
                return Ok(Some(reason));
            }
            let promo = decode::<PromoCode>(&must_get_valid_record(promo_ref.clone())?);
            if let Some(promo) = &promo {
                if let Some(reason) = check_promo_limits(&order, promo_ref, promo)? {
                    return Ok(Some(reason));
                }
            }
            promo
        }
        None => None,
    };
    let needed = promo.as_ref().map_or(0, |p| p.requirement.completed_orders_needed());
    if order.loyalty_proof.len() != needed as usize {
        return Ok(Some(format!("loyalty_proof must list exactly the {needed} completed orders the promo needs")));
    }
    let completed = match count_completed_orders(order.requester, order.catalog_ref, order.loyalty_proof)? {
        Ok(count) => count,
        Err(reason) => return Ok(Some(reason)),
    };
    let food = match &reward {
        // A reward is priced as a promo with no requirement would be -- and
        // must take something off, or its points would be spent for nothing.
        Some(benefit) => {
            let food = order_total(&priced, Some((&PromoRequirement::None, benefit)), 0).unwrap_or(0);
            if food >= catalog_types::subtotal(&priced) {
                return Ok(Some("that reward takes nothing off this order".into()));
            }
            food
        }
        None => match order_total(&priced, promo.as_ref().map(|p| (&p.requirement, &p.reward)), completed) {
            Some(food) => food,
            None => return Ok(Some("the promo code's requirement isn't met by this order".into())),
        },
    };
    // A bag is food at the store's default rate.
    let bags_total: u64 = bags.iter().map(|(_, bag)| bag.price_cents).sum();
    let mut taxable: Vec<TaxableLine> = priced.iter().zip(&categories).map(|(line, category)| TaxableLine { category, total: line.total() }).collect();
    taxable.extend(bags.iter().map(|(_, bag)| TaxableLine { category: "", total: bag.price_cents }));
    Ok(check_taxed_total(&order, food + bags_total, &taxable, "the lines at their priced versions, less any promo discount"))
}

/// Why a goodie bag can't be on this order, if it can't: it's one of the
/// bag, with nothing to choose, from the order's own store, placed before
/// the bag's window closes, for now, and had the way the bag allows.
/// (Whether one is left is the store's to count.) Its owner may order one
/// like anyone -- once, and it's still one fewer for everyone else.
fn bag_line_problem(order: &OrderPricing<'_>, line: &OrderLine, bag: &GoodieBag) -> Option<String> {
    let problem = if line.quantity != 1 || !line.selections.is_empty() {
        "a goodie bag is one to a line, with nothing to choose"
    } else if &bag.catalog_ref != order.catalog_ref {
        "a goodie bag is ordered from its own store"
    } else if order.scheduled || !bag.orderable_at(order.placed_at) {
        "a goodie bag is ordered for now, before its window closes"
    } else if !bag.supports(order.delivery) {
        "this goodie bag isn't offered this way"
    } else {
        return None;
    };
    Some(problem.into())
}

/// A customer has each goodie bag once: no earlier order of theirs since
/// the bag was listed has it -- unless it came to nothing before the store
/// took it on (`earlier_orders`). So nobody holds more than one of a bag,
/// and a declined order doesn't cost them it. The walk is the customer's
/// own chain since the oldest bag's listing, at most a bag's lifetime.
fn check_bags_once(order: &OrderPricing<'_>, bags: &[(&ActionHash, GoodieBag)]) -> ExternResult<Option<String>> {
    let Some(prev) = order.prev_action else { return Ok(Some("an order can't open a chain".into())) };
    let Some(since) = bags.iter().map(|(_, bag)| bag.created_at).min() else { return Ok(None) };
    let Some(earlier) = earlier_orders(order.requester, prev, since)? else {
        return Ok(Some("this account's history is too long to check its goodie bags".into()));
    };
    let again = bags.iter().any(|(bag, _)| earlier.iter().any(|o| o.items.contains(bag)));
    Ok(again.then(|| "a customer has each goodie bag once".into()))
}

/// Why an order with age-restricted items (alcohol, tobacco) can't be
/// placed, if it can't: the network must sell them at all; they're
/// collected in person, where the store checks ID -- never delivered; and
/// the customer confirms their age.
fn age_restriction_problem(order: &OrderPricing<'_>) -> Option<String> {
    let Some(age) = handshake_governance::restricted_min_age() else {
        return Some("this network doesn't sell age-restricted items".into());
    };
    if order.delivery {
        return Some("age-restricted items are collected in person, where the store checks ID".into());
    }
    (!order.age_confirmed).then(|| format!("an order with age-restricted items needs the customer to confirm they're {age} or older"))
}

/// Whether the order's tax and total are what its food comes to under the
/// store's tax -- or what's wrong.
fn check_taxed_total(order: &OrderPricing<'_>, food: u64, lines: &[TaxableLine], what: &str) -> Option<String> {
    let store = order.store;
    let tax = order_tax(lines, food, &store.tax_rates, store.prices_include_tax);
    if order.tax_cents != tax {
        return Some(format!("tax_cents must be {tax}: the store's tax on this order"));
    }
    let expected = total_with_tax(food, tax, store.prices_include_tax);
    (order.order_total != expected).then(|| format!("order_total must be {expected}: {what}, with the store's tax"))
}

/// The rewards an order cites, checked: a version of its own store's
/// program, running, and the reward it spends, if any -- what that takes
/// off the order. Whether the customer's points cover it is the store's to
/// check as it accepts the order: points are private between the two, and
/// follow from the store's own records (`rewards_types`).
fn check_rewards(order: &OrderPricing<'_>) -> ExternResult<Result<Option<PromoReward>, String>> {
    let Some(rewards) = order.rewards else { return Ok(Ok(None)) };
    let program = match rewards_types::program_at(&rewards.program, order.catalog_ref)? {
        Ok(program) => program,
        Err(reason) => return Ok(Err(reason.into())),
    };
    if !program.active {
        return Ok(Err("an order joins a rewards program only while it runs".into()));
    }
    let Some(id) = rewards.reward else { return Ok(Ok(None)) };
    let Some(reward) = program.reward(id) else { return Ok(Err("that program has no such reward".into())) };
    Ok(Ok(Some(reward.benefit.clone())))
}

/// One of the customer's earlier orders, as a promo's limits see it.
struct EarlierOrder {
    order: ActionHash,
    catalog_ref: ActionHash,
    promo_code_ref: Option<ActionHash>,
    placed_at: Timestamp,
    /// What it ordered, by item (a goodie bag's line, by the bag).
    items: Vec<ActionHash>,
}

/// The most of a customer's history a promo's limits read: enough for
/// years of ordering, and a bound on what any one order costs to check.
const MAX_PROMO_WALK: usize = 50_000;

/// The customer's orders from `chain_top` back to `since`, newest first --
/// every one they ever placed in that time is on their own chain -- less
/// those that came to nothing before the store took them on: cancelled by
/// the customer before their app confirmed the store had started, or
/// declined by the store before accepting (as their app noted). Those use
/// up no promo, and don't make them a returning customer. `None` if their
/// history since is longer than `MAX_PROMO_WALK`.
fn earlier_orders(requester: &AgentPubKey, chain_top: &ActionHash, since: Timestamp) -> ExternResult<Option<Vec<EarlierOrder>>> {
    let types = order_types()?;
    let confirmation: ScopedEntryDefIndex = UnitEntryTypes::OrderConfirmation.try_into()?;
    let noted: ScopedEntryDefIndex = UnitEntryTypes::DeclineNoted.try_into()?;
    let activity = handshake_integrity_support::chain::activity_since(requester, chain_top, since)?;
    if activity.len() > MAX_PROMO_WALK {
        return Ok(None);
    }
    let mut orders = Vec::new();
    // Orders cancelled by the customer, confirmed, and declined as noted.
    let (mut cancelled, mut confirmed, mut declined): (Vec<ActionHash>, Vec<ActionHash>, Vec<ActionHash>) = (Vec::new(), Vec::new(), Vec::new());
    for item in &activity {
        let action = &item.action.hashed.content;
        let Some(entry_hash) = action.entry_hash() else { continue };
        let is_order = handshake_integrity_support::chain::creates_one_of(action, &types);
        let is_order_update = matches!(&action.data, ActionData::Update(u) if matches!(&u.entry_type, EntryType::App(def) if types.iter().any(|t| t.zome_index == def.zome_index && t.zome_type == def.entry_index)));
        let is_confirmation = handshake_integrity_support::chain::creates_one_of(action, &[confirmation]);
        let is_noted = handshake_integrity_support::chain::creates_one_of(action, &[noted]);
        if !(is_order || is_order_update || is_confirmation || is_noted) {
            continue;
        }
        let Entry::App(bytes) = handshake_integrity_support::chain::entry_of(item, entry_hash)? else { continue };
        let bytes = SerializedBytes::from(bytes);
        if is_confirmation {
            confirmed.extend(OrderConfirmation::try_from(bytes).ok().map(|c| c.order));
            continue;
        }
        if is_noted {
            declined.extend(DeclineNoted::try_from(bytes).ok().map(|d| d.order));
            continue;
        }
        let order = DeliveryOrder::try_from(bytes.clone())
            .ok()
            .map(|o| (o.catalog_ref, o.promo_code_ref, o.cancellation.is_some(), o.merchant, o.lines))
            .or_else(|| PickupOrder::try_from(bytes).ok().map(|o| (o.catalog_ref, o.promo_code_ref, o.cancellation.is_some(), o.merchant, o.lines)));
        let Some((catalog_ref, promo_code_ref, has_cancellation, merchant, lines)) = order else { continue };
        if is_order {
            let items = lines.into_iter().map(|line| line.item_ref).collect();
            orders.push(EarlierOrder { order: item.action.hashed.hash.clone(), catalog_ref, promo_code_ref, placed_at: action.timestamp(), items });
        } else if has_cancellation {
            // The customer's own update cancelling it -- their only one
            // with a cancellation, since they write nothing after. Written
            // on the store's started version, it was seen started.
            let original = original_creation(item.action.hashed.hash.clone())?;
            if dispatch_types::lineage::cancels_started(&item.action.hashed.hash, &merchant)? {
                confirmed.push(original.clone());
            }
            cancelled.push(original);
        }
    }
    orders.retain(|o| !declined.contains(&o.order) && !(cancelled.contains(&o.order) && !confirmed.contains(&o.order)));
    Ok(Some(orders))
}

/// A promo's limits (`catalog_types::PromoLimits`), held against the
/// customer's own earlier orders: their first order at the store, so many
/// uses in all, once a day, week or month in the store's time. An order
/// counts once it's placed, cancelled or not. A promo is known by its
/// original action, whichever version an order cites. (`total`, across
/// customers, is the store's to enforce -- see `PromoLimits`.)
fn check_promo_limits(order: &OrderPricing<'_>, promo_ref: &ActionHash, promo: &PromoCode) -> ExternResult<Option<String>> {
    let limits = &promo.limits;
    if !limits.first_order_only && limits.per_customer.is_none() && limits.once_per.is_none() {
        return Ok(None);
    }
    let Some(prev) = order.prev_action else { return Ok(Some("an order can't open a chain".into())) };
    let identity = original_creation(promo_ref.clone())?;
    // Back to when the store opened, for a first order; else to the promo's
    // own creation -- nothing used it before.
    let since = if limits.first_order_only { must_get_action(order.catalog_ref.clone())?.hashed.content.timestamp() } else { must_get_action(identity.clone())?.hashed.content.timestamp() };
    let Some(earlier) = earlier_orders(order.requester, prev, since)? else {
        return Ok(Some("this account's history is too long to check this promo's limits".into()));
    };
    if limits.first_order_only && earlier.iter().any(|o| &o.catalog_ref == order.catalog_ref) {
        return Ok(Some("that promo is for a customer's first order here".into()));
    }
    let mut uses = Vec::new();
    for o in &earlier {
        if let Some(cited) = &o.promo_code_ref {
            if &o.catalog_ref == order.catalog_ref && original_creation(cited.clone())? == identity {
                uses.push(o.placed_at);
            }
        }
    }
    if limits.per_customer.is_some_and(|n| uses.len() >= n as usize) {
        return Ok(Some("that promo has been used as many times as it allows".into()));
    }
    if let Some(period) = limits.once_per {
        // A scheduled order is accepted against when it opens, not when it
        // was written -- so its own date could be set back into a period
        // not yet used. Once-a-period promos are for orders placed now.
        if order.scheduled {
            return Ok(Some("a promo limited to once a day, week or month is used on an order placed now".into()));
        }
        let now = rewards_types::period_of(order.placed_at, &order.store.time_zone, period);
        if uses.iter().any(|at| rewards_types::period_of(*at, &order.store.time_zone, period) == now) {
            return Ok(Some("that promo has been used already this period".into()));
        }
    }
    Ok(None)
}

/// How many distinct earlier orders at this store `proof` shows the
/// requester completed. Each entry must be the requester's own completion
/// (`Delivered`/`PickedUp`) of an order at this store -- the customer
/// authors both, so each is on their own chain.
fn count_completed_orders(requester: &AgentPubKey, catalog_ref: &ActionHash, proof: &[ActionHash]) -> ExternResult<Result<u32, String>> {
    let mut orders = BTreeSet::new();
    for completion in proof {
        // A version completing one of the customer's own orders at this
        // store -- whoever wrote it: a delivery's driver completes it on the
        // customer's own proof.
        let record = must_get_valid_record(completion.clone())?;
        if !matches!(record.action().data, ActionData::Update(_)) {
            return Ok(Err("loyalty_proof must be order completions".into()));
        }
        let completed_here = if let Some(order) = decode::<DeliveryOrder>(&record) {
            &order.requester == requester && matches!(order.status, DeliveryStatus::Delivered | DeliveryStatus::Collected) && &order.catalog_ref == catalog_ref
        } else if let Some(order) = decode::<PickupOrder>(&record) {
            &order.requester == requester && order.status == PickupStatus::PickedUp && &order.catalog_ref == catalog_ref
        } else {
            false
        };
        if !completed_here {
            return Ok(Err("each loyalty_proof entry must complete an order at this store".into()));
        }
        if !orders.insert(original_creation(completion.clone())?) {
            return Ok(Err("loyalty_proof lists the same order twice".into()));
        }
    }
    Ok(Ok(orders.len() as u32))
}

/// The promo must belong to this order's store and not have expired when
/// the order was placed. (The discount's effect on `order_total` isn't
/// re-derived here: that would need the full cart, which an order doesn't
/// carry.)
pub(crate) fn check_promo_code(promo_ref: &ActionHash, catalog_ref: &ActionHash, placed_at: Timestamp) -> ExternResult<Option<String>> {
    let Some(promo) = decode::<PromoCode>(&must_get_valid_record(promo_ref.clone())?) else {
        return Ok(Some("promo_code_ref does not point at a PromoCode entry".into()));
    };
    if &promo.catalog_ref != catalog_ref {
        return Ok(Some("promo_code_ref does not belong to this order's store".into()));
    }
    if promo.expires_at.is_some_and(|expires| placed_at >= expires) {
        return Ok(Some("promo code has expired".into()));
    }
    Ok(None)
}

/// Why a customer can't place another order now, if they can't: they've
/// placed as many as the network allows within one store response window
/// (`handshake_governance::max_pending_orders`), counting back from this one's
/// time `at` -- which can't be earlier than the chain before it.
pub(crate) fn check_order_rate(requester: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<Option<String>> {
    let Some(prev_action) = prev_action else { return Ok(None) };
    let window = handshake_governance::store_response_window().as_micros() as i64;
    let since = Timestamp::from_micros(at.as_micros() - window);
    let placed = entries_since(requester, prev_action, since, &order_types()?)?.len();
    if placed >= handshake_governance::max_pending_orders() as usize {
        return Ok(Some("you've placed as many orders as the network allows at once; wait for a store to answer".into()));
    }
    early_cancels_problem(requester, prev_action, at)
}

/// The most of a customer's last day a placement walks for their early
/// cancellations. An ordinary customer's day is a few dozen actions; a key
/// that also runs a busy store can be more. Past it the network-wide
/// allowance isn't checked -- each store still declines a customer who
/// keeps cancelling on it (`acceptance::serial_canceller`) -- rather than
/// refusing every order such a key places. Writing that many actions a day
/// to slip past it is more spam than it saves.
const MAX_CANCEL_WALK: usize = 20_000;

/// Why a customer can't place an order: they've called off the network's
/// daily allowance of orders before any store answered them
/// (`handshake_governance::max_daily_early_cancels`) -- spread across stores
/// or not -- in the day before `at`. Read from their own chain.
pub(crate) fn early_cancels_problem(requester: &AgentPubKey, prev_action: &ActionHash, at: Timestamp) -> ExternResult<Option<String>> {
    let since = Timestamp::from_micros(at.as_micros() - 86_400_000_000);
    let activity = handshake_integrity_support::chain::activity_since(requester, prev_action, since)?;
    if activity.len() > MAX_CANCEL_WALK {
        return Ok(None);
    }
    let types = order_types()?;
    let most = handshake_governance::max_daily_early_cancels() as usize;
    let mut early = 0;
    for item in &activity {
        let action = &item.action.hashed.content;
        let ActionData::Update(update) = &action.data else { continue };
        if !matches!(&update.entry_type, EntryType::App(def) if types.iter().any(|t| t.zome_index == def.zome_index && t.zome_type == def.entry_index)) {
            continue;
        }
        let Entry::App(bytes) = handshake_integrity_support::chain::entry_of(item, &update.entry_hash)? else { continue };
        let bytes = SerializedBytes::from(bytes);
        let by_customer = DeliveryOrder::try_from(bytes.clone()).ok().map(|o| o.cancellation == Some(Cancellation::ByCustomer)).or_else(|| PickupOrder::try_from(bytes).ok().map(|o| o.cancellation == Some(Cancellation::ByCustomer)));
        if by_customer != Some(true) {
            continue;
        }
        // Before any store answered: it cancelled the order as placed.
        let prior = must_get_valid_record(update.original_action_address.clone())?;
        let from_placed = decode::<DeliveryOrder>(&prior).is_some_and(|o| o.status == DeliveryStatus::Placed) || decode::<PickupOrder>(&prior).is_some_and(|o| o.status == PickupStatus::Placed);
        if from_placed {
            early += 1;
            if early >= most {
                return Ok(Some("you've called off as many orders today as the network allows before stores could answer; try again tomorrow".into()));
            }
        }
    }
    Ok(None)
}
