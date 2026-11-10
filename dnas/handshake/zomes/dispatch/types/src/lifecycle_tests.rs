//! The order lifecycles as a specification: every pair of statuses checked
//! against properties the money and the handoffs rest on, and the table
//! `docs/ORDER_STATES.md` publishes rendered from the same function
//! validation calls -- so the spec, the rules and the document can't drift.

use super::*;

/// Every delivery status, by a match that stops compiling when one's added.
fn every_delivery() -> Vec<DeliveryStatus> {
    use DeliveryStatus::*;
    let all = vec![Scheduled, Placed, Open, BidAccepted, DriverEnRouteToMerchant, MerchantConfirmed, DriverAtStore, PickedUp, Delivered, Cancelled, Disputed, Collecting, Collected, Unanswered];
    for status in &all {
        match status {
            Scheduled | Placed | Open | BidAccepted | DriverEnRouteToMerchant | MerchantConfirmed | DriverAtStore | PickedUp | Delivered | Cancelled | Disputed | Collecting | Collected | Unanswered => {}
        }
    }
    all
}

fn every_pickup() -> Vec<PickupStatus> {
    use PickupStatus::*;
    let all = vec![Placed, MerchantConfirmed, ReadyForPickup, PickedUp, Cancelled, Disputed];
    for status in &all {
        match status {
            Placed | MerchantConfirmed | ReadyForPickup | PickedUp | Cancelled | Disputed => {}
        }
    }
    all
}

fn delivery_edges() -> Vec<(DeliveryStatus, DeliveryStatus, RequiredAuthor)> {
    let all = every_delivery();
    all.iter().flat_map(|from| all.iter().filter_map(move |to| from.transition_requirement(to).map(|who| (from.clone(), to.clone(), who)))).collect()
}

fn pickup_edges() -> Vec<(PickupStatus, PickupStatus, RequiredAuthor)> {
    let all = every_pickup();
    all.iter().flat_map(|from| all.iter().filter_map(move |to| from.transition_requirement(to).map(|who| (from.clone(), to.clone(), who)))).collect()
}

/// The statuses reachable from `start` along `edges`.
fn reachable<S: Clone + PartialEq>(start: &[S], edges: &[(S, S, RequiredAuthor)]) -> Vec<S> {
    let mut seen: Vec<S> = start.to_vec();
    let mut i = 0;
    while i < seen.len() {
        let here = seen[i].clone();
        for (from, to, _) in edges {
            if *from == here && !seen.contains(to) {
                seen.push(to.clone());
            }
        }
        i += 1;
    }
    seen
}

#[test]
fn a_finished_order_stays_finished() {
    for (from, to, _) in delivery_edges() {
        assert!(!from.is_terminal(), "{from:?} is final, yet moves to {to:?}");
        assert_ne!(from, to, "{from:?} moves to itself");
    }
    for (from, to, _) in pickup_edges() {
        assert!(!from.is_terminal(), "{from:?} is final, yet moves to {to:?}");
        assert_ne!(from, to, "{from:?} moves to itself");
    }
}

#[test]
fn every_status_is_reachable_and_every_order_can_finish() {
    let edges = delivery_edges();
    let starts = [DeliveryStatus::Scheduled, DeliveryStatus::Placed];
    let reached = reachable(&starts, &edges);
    for status in every_delivery() {
        assert!(reached.contains(&status), "{status:?} can't be reached");
        let onward = reachable(std::slice::from_ref(&status), &edges);
        assert!(onward.iter().any(DeliveryStatus::is_terminal), "an order at {status:?} can never finish");
    }
    let edges = pickup_edges();
    let reached = reachable(&[PickupStatus::Placed], &edges);
    for status in every_pickup() {
        assert!(reached.contains(&status), "{status:?} can't be reached");
        assert!(reachable(std::slice::from_ref(&status), &edges).iter().any(PickupStatus::is_terminal), "a pickup at {status:?} can never finish");
    }
}

#[test]
fn once_the_food_has_left_the_store_it_is_never_simply_called_off() {
    use DeliveryStatus::*;
    for (from, to, _) in delivery_edges() {
        if matches!(from, PickedUp | Unanswered | Disputed) {
            assert!(!matches!(to, Cancelled | Open | Collecting), "{from:?} -> {to:?}: the food is with the driver");
        }
    }
}

#[test]
fn delivered_needs_the_food_to_have_left_the_store() {
    use DeliveryStatus::*;
    for (from, to, who) in delivery_edges() {
        if to == Delivered {
            assert!(matches!(from, PickedUp | Unanswered | Disputed), "{from:?} -> Delivered skips the pickup");
            assert_eq!(who, RequiredAuthor::RequesterOrProvider, "{from:?} -> Delivered: only the customer, or the driver holding their proof");
        }
    }
}

#[test]
fn each_party_decides_only_what_is_theirs() {
    use DeliveryStatus::*;
    for (from, to, who) in delivery_edges() {
        match (&from, &to) {
            // Accepting a bid seals the address to that driver: the customer's alone.
            (Open, BidAccepted) => assert_eq!(who, RequiredAuthor::Requester),
            // Accepting an order is the store's check it's priced from its menu.
            (Placed, Open) => assert_eq!(who, RequiredAuthor::Merchant),
            // Cooking, checking a driver in and handing over to a collector are the store's.
            (_, MerchantConfirmed | DriverAtStore | Collecting) => assert_eq!(who, RequiredAuthor::Merchant, "{from:?} -> {to:?}"),
            // Only the customer says it never came.
            (_, Disputed) => assert_eq!(who, RequiredAuthor::Requester, "{from:?} -> Disputed"),
            // Only the driver says nobody answered, or commits to it.
            (_, Unanswered | DriverEnRouteToMerchant) => assert_eq!(who, RequiredAuthor::AcceptedProvider, "{from:?} -> {to:?}"),
            _ => {}
        }
        // A driver alone never calls an order off before they're at the counter.
        if to == Cancelled && from != DriverAtStore {
            assert!(!matches!(who, RequiredAuthor::AcceptedProvider | RequiredAuthor::AnyParty | RequiredAuthor::MerchantOrProvider | RequiredAuthor::RequesterOrProvider), "{from:?} -> Cancelled by a driver");
        }
    }
    for (from, to, who) in pickup_edges() {
        if to == PickupStatus::PickedUp {
            assert_eq!(who, RequiredAuthor::Requester, "{from:?} -> PickedUp: only the customer says they have it");
        }
        if to == PickupStatus::Disputed {
            assert_eq!(who, RequiredAuthor::Requester);
        }
    }
}

fn who(author: RequiredAuthor) -> &'static str {
    match author {
        RequiredAuthor::Requester => "customer",
        RequiredAuthor::Merchant => "store",
        RequiredAuthor::RequesterOrMerchant => "customer or store",
        RequiredAuthor::AcceptedProvider => "driver",
        RequiredAuthor::RequesterOrProvider => "customer or driver",
        RequiredAuthor::MerchantOrProvider => "store or driver",
        RequiredAuthor::AnyParty => "any of the three",
    }
}

fn table<S: core::fmt::Debug>(edges: &[(S, S, RequiredAuthor)]) -> String {
    let mut out = String::from("| From | To | Who may write it |\n|---|---|---|\n");
    for (from, to, author) in edges {
        out.push_str(&format!("| {from:?} | {to:?} | {} |\n", who(*author)));
    }
    out
}

/// What `docs/ORDER_STATES.md` holds between `begin` and `end`.
fn section<'a>(doc: &'a str, begin: &str, end: &str) -> &'a str {
    let start = doc.find(begin).unwrap_or_else(|| panic!("ORDER_STATES.md has no {begin}")) + begin.len();
    let stop = doc[start..].find(end).unwrap_or_else(|| panic!("ORDER_STATES.md has no {end}")) + start;
    doc[start..stop].trim()
}

#[test]
fn the_published_spec_is_the_rules() {
    let doc = include_str!("../../../../../../docs/ORDER_STATES.md");
    let delivery = table(&delivery_edges());
    let pickup = table(&pickup_edges());
    assert_eq!(section(doc, "<!-- delivery:begin -->", "<!-- delivery:end -->"), delivery.trim(), "docs/ORDER_STATES.md's delivery table is out of date; it should read:\n{delivery}");
    assert_eq!(section(doc, "<!-- pickup:begin -->", "<!-- pickup:end -->"), pickup.trim(), "docs/ORDER_STATES.md's pickup table is out of date; it should read:\n{pickup}");
}
