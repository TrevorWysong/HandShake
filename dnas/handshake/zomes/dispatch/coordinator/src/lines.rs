//! An order's lines as people read them -- the item, what each unit cost
//! with its choices, and the choices themselves ("Large", "2 x Extra shot",
//! "Fries (Large)") -- for the kitchen, the customer, receipts and reports.
//! Prices come from the exact versions each line was priced at, so they're
//! what the customer paid.

use catalog_types::{GoodieBag, MenuItem, ModifierGroup};
use dispatch_integrity::*;
use hdk::prelude::*;
use handshake_integrity_support::allergens::AllergenFacts;
use handshake_coordinator_support::{decode_or, guest, original_action_of, resolve_latest};

/// One line of an order, described.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LineView {
    /// The item's original action, as the order names it.
    pub item_ref: ActionHash,
    pub name: String,
    pub quantity: u32,
    /// With its choices.
    pub unit_price_cents: u64,
    /// Each chosen option, in the order the item asks for them.
    pub choices: Vec<String>,
    /// Whether it's a goodie bag -- what's in it is the store's call.
    pub goodie_bag: bool,
    /// What its store said was in it, in the version that was ordered: `None`
    /// if it hadn't said. What's said now may differ; this is what it was.
    pub allergens: Option<AllergenFacts>,
    /// What the chosen options add, as the store said of them.
    pub choices_contain: Vec<String>,
    pub choices_contain_other: Vec<String>,
}

/// An order's lines, described -- public, as the lines themselves are.
#[hdk_extern]
pub fn get_order_lines(order_ref: ActionHash) -> ExternResult<Vec<LineView>> {
    let record = resolve_latest(original_action_of(order_ref)?)?;
    let lines = match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => o.lines,
        (None, Some(o)) => o.lines,
        _ => return Err(guest("that isn't an order")),
    };
    describe(&lines)
}

pub(crate) fn describe(lines: &[OrderLine]) -> ExternResult<Vec<LineView>> {
    let mut pricer = LinePricer::default();
    lines.iter().map(|line| describe_line(line, &mut pricer)).collect()
}

fn describe_line(line: &OrderLine, pricer: &mut LinePricer) -> ExternResult<LineView> {
    let version = fetch(&line.priced_version)?;
    let (name, unit_price_cents, goodie_bag, allergens) = if let Some(item) = decode_or::<MenuItem>(&version) {
        let price = pricer.unit_price(&item, &line.selections)?.map_err(guest)?;
        (item.name, price, false, item.allergens)
    } else if let Some(bag) = decode_or::<GoodieBag>(&version) {
        (bag.title, bag.price_cents, true, bag.allergens)
    } else {
        return Err(guest("an order line isn't priced from an item"));
    };
    let mut choices = Vec::new();
    let (mut choices_contain, mut choices_contain_other) = (Vec::new(), Vec::new());
    for selection in &line.selections {
        choices.extend(labels(selection)?);
        collect_allergens(selection, &mut choices_contain, &mut choices_contain_other)?;
    }
    Ok(LineView { item_ref: line.item_ref.clone(), name, quantity: line.quantity, unit_price_cents, choices, goodie_bag, allergens, choices_contain, choices_contain_other })
}

/// What was chosen from one group, an entry per option: "2 x Extra shot",
/// with what was chosen from its nested group after it in brackets.
fn labels(selection: &Selection) -> ExternResult<Vec<String>> {
    let group = decode_or::<ModifierGroup>(&fetch(&selection.version)?).ok_or(guest("a choice on this order isn't from a choice group"))?;
    let mut out = Vec::with_capacity(selection.options.len());
    for chosen in &selection.options {
        let name = group.options.iter().find(|o| o.id == chosen.option).map_or("(removed)", |o| o.name.as_str());
        let mut label = if chosen.quantity > 1 { format!("{} x {name}", chosen.quantity) } else { name.to_string() };
        let mut nested = Vec::new();
        for inner in &chosen.nested {
            nested.extend(labels(inner)?);
        }
        if !nested.is_empty() {
            label = format!("{label} ({})", nested.join(", "));
        }
        out.push(label);
    }
    Ok(out)
}

/// What the options chosen from one group, and any nested in them, say they add.
fn collect_allergens(selection: &Selection, contain: &mut Vec<String>, other: &mut Vec<String>) -> ExternResult<()> {
    let group = decode_or::<ModifierGroup>(&fetch(&selection.version)?).ok_or(guest("a choice on this order isn't from a choice group"))?;
    for chosen in &selection.options {
        if let Some(option) = group.options.iter().find(|o| o.id == chosen.option) {
            contain.extend(option.contains.iter().filter(|a| !contain.contains(a)).cloned().collect::<Vec<_>>());
            other.extend(option.other_allergens.iter().filter(|o| !other.contains(o)).cloned().collect::<Vec<_>>());
        }
        for inner in &chosen.nested {
            collect_allergens(inner, contain, other)?;
        }
    }
    Ok(())
}

fn fetch(version: &ActionHash) -> ExternResult<Record> {
    match get(version.clone(), GetOptions::local())? {
        Some(record) => Ok(record),
        None => get(version.clone(), GetOptions::network())?.ok_or(guest("Something on this order couldn't be found. Try again in a moment.")),
    }
}

