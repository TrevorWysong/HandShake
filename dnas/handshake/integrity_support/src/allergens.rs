//! Allergens: what a store says about its food, and what a customer tells a
//! store. A fixed list, so every store's word means the same and can be
//! translated and matched, with room for a store's own words beyond it. Each
//! is someone's own statement: the network checks its shape, and can't check
//! a kitchen.

use crate::limits::{MAX_ALLERGENS_LISTED, MAX_ALLERGEN_LABELS, MAX_ALLERGY_BYTES, MAX_LABEL_CHARS, MAX_NOTE_CHARS};
use crate::text_problem;
use hdi::prelude::*;

// Allergens go by code: "Peanuts", "TreeNuts". Codes, not a closed list in these
// rules, so one a new region names can be added by updating the app, without a
// new network, and an app that doesn't know it still shows it as written. The
// app's list is `web/src/lib/storefront/allergens.ts`.

/// The longest an allergen's code may be.
const MAX_ALLERGEN_CODE_CHARS: usize = 32;

fn code_problem(code: &str) -> bool {
    let mut chars = code.chars();
    code.len() > MAX_ALLERGEN_CODE_CHARS || !chars.next().is_some_and(|c| c.is_ascii_uppercase()) || !chars.all(|c| c.is_ascii_alphanumeric())
}

/// What a store says about one menu item. An item without these has said
/// nothing -- which never reads as safe -- and one with them all empty says
/// it has none of the list in it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct AllergenFacts {
    /// In the recipe.
    pub contains: Vec<String>,
    /// Not in the recipe, but it may meet it: a shared fryer, a shared board.
    pub may_contain: Vec<String>,
    /// In the store's own words, for what the list doesn't name: "Kiwi".
    pub other: Vec<String>,
    /// Anything else a person should know about this item.
    pub note: String,
    /// Of what's in it, what the kitchen can leave out if asked.
    #[serde(default)]
    pub can_omit: Vec<String>,
}

/// How a store takes a customer's allergy request.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllergyRequests {
    /// It reads each one and works to it.
    Welcome,
    /// It'll try, and promises nothing.
    BestEffort,
    /// It can't work to them: a customer sees so before they order.
    NotAccepted,
}

/// How a store handles allergens across its kitchen.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AllergyPolicy {
    /// Handled somewhere in its kitchen, so anything it makes may meet them.
    pub kitchen: Vec<String>,
    /// The same, in the store's own words.
    pub other: Vec<String>,
    pub requests: AllergyRequests,
    /// Anything else a person with an allergy should know.
    pub note: String,
    /// Whether the store's auto-accept may take an order with allergies on it,
    /// for a kitchen that works from the ticket. Off, a person accepts each.
    #[serde(default)]
    pub auto_accept_requests: bool,
}

/// A customer's allergies: kept sealed on their own account, and sealed to
/// the store on an order when they choose to send them.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct AllergySet {
    pub allergens: Vec<String>,
    pub other: Vec<String>,
}

impl AllergySet {
    pub fn is_empty(&self) -> bool {
        self.allergens.is_empty() && self.other.is_empty()
    }

    /// Bounded in bytes too, so the longest note and the longest list sealed
    /// together still fit the keystore's frame (`seal_padded`).
    pub fn problem(&self) -> Option<String> {
        let bytes: usize = self.allergens.iter().chain(&self.other).map(String::len).sum();
        list_problem(&self.allergens).or_else(|| labels_problem(&self.other)).or_else(|| (bytes > MAX_ALLERGY_BYTES).then(|| "That's more allergies than an order can carry. Shorten the ones you've written yourself.".to_string()))
    }
}

impl AllergenFacts {
    pub fn problem(&self) -> Option<String> {
        list_problem(&self.contains)
            .or_else(|| list_problem(&self.may_contain))
            .or_else(|| self.contains.iter().any(|a| self.may_contain.contains(a)).then(|| "an allergen is either in an item or may be, not both".to_string()))
            .or_else(|| list_problem(&self.can_omit))
            .or_else(|| self.can_omit.iter().any(|a| !self.contains.contains(a)).then(|| "only what's in an item can be left out of it".to_string()))
            .or_else(|| labels_problem(&self.other))
            .or_else(|| text_problem("an allergen note", &self.note, MAX_NOTE_CHARS))
    }
}

impl AllergyPolicy {
    pub fn problem(&self) -> Option<String> {
        list_problem(&self.kitchen)
            .or_else(|| labels_problem(&self.other))
            .or_else(|| text_problem("an allergy note", &self.note, MAX_NOTE_CHARS))
    }
}

/// A list of codes: each well-formed, each once, and only so many.
pub fn list_problem(allergens: &[String]) -> Option<String> {
    if allergens.len() > MAX_ALLERGENS_LISTED {
        return Some(format!("at most {MAX_ALLERGENS_LISTED} allergens"));
    }
    if allergens.iter().any(|a| code_problem(a)) {
        return Some("that isn't an allergen's code".to_string());
    }
    allergens.iter().enumerate().any(|(i, a)| allergens[..i].contains(a)).then(|| "an allergen is listed once".to_string())
}

/// A store's or customer's own words: a few, short, and each saying something.
pub fn labels_problem(labels: &[String]) -> Option<String> {
    if labels.len() > MAX_ALLERGEN_LABELS {
        return Some(format!("at most {MAX_ALLERGEN_LABELS} allergens of your own"));
    }
    labels.iter().find_map(|label| {
        if label.trim().is_empty() {
            return Some("an allergen of your own has a name".to_string());
        }
        text_problem("an allergen's name", label, MAX_LABEL_CHARS)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> AllergenFacts {
        AllergenFacts { contains: vec!["Milk".to_string()], may_contain: vec!["Peanuts".to_string()], other: vec!["Kiwi".into()], note: "Fried in shared oil.".into(), can_omit: vec!["Milk".to_string()] }
    }

    #[test]
    fn honest_facts_pass_and_saying_none_is_a_statement() {
        assert_eq!(facts().problem(), None);
        assert_eq!(AllergenFacts::default().problem(), None);
    }

    #[test]
    fn a_list_can_not_contradict_itself() {
        assert!(AllergenFacts { contains: vec!["Milk".to_string(), "Milk".to_string()], ..facts() }.problem().is_some());
        assert!(AllergenFacts { may_contain: vec!["Milk".to_string()], ..facts() }.problem().is_some());
        assert!(AllergenFacts { can_omit: vec!["Soy".to_string()], ..facts() }.problem().is_some(), "can't leave out what isn't in it");
    }

    #[test]
    fn a_code_is_a_code() {
        assert_eq!(list_problem(&["Peanuts".to_string(), "TreeNuts".to_string(), "Buckwheat".to_string()]), None, "one this version has never heard of is fine");
        for bad in ["", "peanuts", "Not safe", "Peanuts!", &"X".repeat(MAX_ALLERGEN_CODE_CHARS + 1)] {
            assert!(list_problem(&[bad.to_string()]).is_some(), "{bad}");
        }
        assert!(list_problem(&(0..=MAX_ALLERGENS_LISTED).map(|i| format!("A{i}")).collect::<Vec<_>>()).is_some());
    }

    #[test]
    fn a_stores_own_words_are_bounded() {
        assert!(AllergenFacts { other: vec!["  ".into()], ..facts() }.problem().is_some());
        assert!(AllergenFacts { other: vec!["x".repeat(MAX_LABEL_CHARS + 1)], ..facts() }.problem().is_some());
        assert!(AllergenFacts { other: vec!["Kiwi".into(); MAX_ALLERGEN_LABELS + 1], ..facts() }.problem().is_some());
        assert!(AllergenFacts { note: "x".repeat(MAX_NOTE_CHARS + 1), ..facts() }.problem().is_some());
    }

    #[test]
    fn a_policy_and_a_customers_set_are_held_to_the_same() {
        let policy = AllergyPolicy { kitchen: vec!["Peanuts".to_string()], other: vec![], requests: AllergyRequests::Welcome, note: String::new(), auto_accept_requests: false };
        assert_eq!(policy.problem(), None);
        assert!(AllergyPolicy { kitchen: vec!["Soy".to_string(), "Soy".to_string()], ..policy.clone() }.problem().is_some());
        assert!(AllergySet { allergens: vec!["Soy".to_string(), "Soy".to_string()], other: vec![] }.problem().is_some());
        assert!(AllergySet { allergens: vec![], other: vec![String::new()] }.problem().is_some());
        assert!(AllergySet { allergens: vec![], other: vec!["🌰".repeat(MAX_LABEL_CHARS.min(100)); MAX_ALLERGEN_LABELS] }.problem().is_some(), "a list has a size");
        assert!(AllergySet::default().is_empty());
    }
}
