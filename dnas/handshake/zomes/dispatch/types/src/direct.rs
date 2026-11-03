//! Direct payments: an order's money moves on its parties' own card
//! processors, not on a ledger. Each payer's card is authorized on its
//! payee's own processor account -- a **leg** -- and its payee settles it
//! with a single capture of what the network says they're owed, releasing
//! the rest. Nobody holds anybody else's money, and nothing is minted.
//!
//! - **Customer**: the customer's card, on the store's account -- the food,
//!   their share of the delivery fee at their cap, and their tip. The store
//!   passes the fee and tip on to the driver.
//! - **Driver pay**: the store's card, on the driver's account -- the whole
//!   fee (both shares) and the tip.
//! - **Collateral**: the driver's card, on the store's account -- the value
//!   of the food they carry.
//!
//! Who's owed what is exactly as before: the money is still made of the
//! parts of `settlement`'s holds (`hold_terms`), and a part's payee takes
//! it on the same grounds its recipient could collect it (`entitlement`).
//! A leg only gathers parts by who pays them now:
//!
//! | Part | Recipient | Leg it's captured on |
//! |---|---|---|
//! | Food | store | Customer |
//! | Driver pay: fee, tip | driver | Customer (the store passes it on) and Driver pay |
//! | Subsidy: fee, late cover | driver | Driver pay |
//! | Collateral | store | Collateral |
//!
//! The customer's share of the fee and their tip appear on two legs: the
//! store takes them from the customer only as the driver takes them from
//! the store (validation ties the two), so the store never keeps a
//! driver's money, and the customer never pays a fee no driver earned.

use super::{hold_terms, split_delivery_fee, Bid, Cancellation, HoldPurpose, OrderTerms, Portion};
use hdi::prelude::*;

/// One card authorization an order needs.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Leg {
    /// The customer's, on the store's account.
    Customer,
    /// The store's, on the account of the driver behind `bid`.
    DriverPay { bid: ActionHash },
    /// The driver's behind `bid`, on the store's account.
    Collateral { bid: ActionHash },
}

/// A part of an order's money: a portion of one of its holds, as
/// `hold_terms` prices it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub purpose: HoldPurpose,
    pub portion: Portion,
}

impl Leg {
    /// The bid a leg is for, if it's a driver's.
    pub fn bid(&self) -> Option<&ActionHash> {
        match self {
            Leg::Customer => None,
            Leg::DriverPay { bid } | Leg::Collateral { bid } => Some(bid),
        }
    }

    /// Who pays it and who's paid (whose account it's held on). `bid` is the
    /// leg's own, where it has one.
    pub fn parties(&self, terms: &OrderTerms, bid: Option<&Bid>) -> Option<(AgentPubKey, AgentPubKey)> {
        match (self, bid) {
            (Leg::Customer, None) => Some((terms.requester.clone(), terms.merchant.clone())),
            (Leg::DriverPay { .. }, Some(bid)) if terms.delivery => Some((terms.merchant.clone(), bid.bidder.clone())),
            (Leg::Collateral { .. }, Some(bid)) if terms.delivery => Some((bid.bidder.clone(), terms.merchant.clone())),
            _ => None,
        }
    }

    /// Whether `part` is captured on this leg.
    pub fn includes(&self, part: &Part) -> bool {
        match (self, &part.purpose, part.portion) {
            (Leg::Customer, HoldPurpose::Food, Portion::Food) => true,
            (Leg::Customer, HoldPurpose::DriverPay { .. }, Portion::Fee | Portion::Tip) => true,
            (Leg::DriverPay { bid }, HoldPurpose::DriverPay { bid: b }, Portion::Fee | Portion::Tip) => bid == b,
            (Leg::DriverPay { bid }, HoldPurpose::Subsidy { bid: b }, Portion::Fee | Portion::LateCover) => bid == b,
            (Leg::Collateral { bid }, HoldPurpose::Collateral { bid: b }, Portion::Collateral) => bid == b,
            _ => false,
        }
    }

    /// The most this leg can ever capture -- what's authorized. `None` if it
    /// can't be paid directly: a delivery with no fee cap, whose customer
    /// would otherwise authorize an unbounded fee. Zero if payer and payee
    /// are one (a store ordering from itself pays itself nothing).
    pub fn required(&self, terms: &OrderTerms, bid: Option<&Bid>) -> Option<u64> {
        let (payer, payee) = self.parties(terms, bid)?;
        if payer == payee {
            return Some(0);
        }
        Some(match (self, bid) {
            (Leg::Customer, _) if terms.delivery => {
                let (_, customer_share) = split_delivery_fee(terms.fee_cap?, terms.delivery_subsidy_percent);
                terms.order_total + customer_share + terms.tip_cents
            }
            (Leg::Customer, _) => terms.order_total,
            (Leg::DriverPay { .. }, Some(bid)) => bid.price_offer + terms.tip_cents,
            (Leg::Collateral { .. }, Some(bid)) => bid.collateral,
            _ => return None,
        })
    }
}

/// What `part` is worth, and who it's for (`hold_terms`) -- `None` if the
/// order has no such part: a portion of nothing, a part someone would pay
/// themselves, or a driver's part on a pickup.
pub fn part_share(terms: &OrderTerms, part: &Part, bid: Option<&Bid>) -> Option<(AgentPubKey, u64)> {
    let (_, shares) = hold_terms(terms, &part.purpose, bid)?;
    shares.into_iter().find(|share| share.portion == part.portion).map(|share| (share.recipient, share.amount))
}

/// How far an order had got when it was cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Not yet accepted by the store.
    Waiting,
    /// Accepted; no driver yet (or a pickup order being prepared).
    Accepted,
    /// A driver assigned, not yet at the store.
    DriverAssigned,
    /// The driver checked in at the store.
    AtStore,
    Other,
}

/// An order's cancellation, as its parts turn on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cancelled {
    pub by: Cancellation,
    /// How far the order had got.
    pub from: Stage,
    /// Whether the store had started cooking it.
    pub cooking: bool,
    /// The driver's bid the order had, if any.
    pub bid: Option<ActionHash>,
    /// For `NoDriver`: the bid of the driver who answers for the food.
    pub liable: Option<ActionHash>,
}

/// What a capture rests on: a decision or step on the order's own record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Basis {
    /// The store's decision that the order reached its customer, with the
    /// bid that delivered it.
    Delivered { bid: Option<ActionHash> },
    /// The store's decision that it never did, with the bid that had it.
    NotDelivered { bid: Option<ActionHash> },
    /// The store's settlement of the food, with the refund it names.
    Settled { refund: u64 },
    /// The order cancelled.
    Cancelled(Cancelled),
    /// The driver behind `bid` leaving before pickup: whether they were
    /// calling the store late (they leave paid in full), and whether they
    /// left from the counter, checked in.
    Released { bid: ActionHash, store_late: bool, at_store: bool },
    /// After the driver behind `bid` left, another driver confirmed, or the
    /// customer collecting it: the first no longer answers for the food.
    Replaced { bid: ActionHash },
}

/// A check only the parties' chains can answer -- what a customer knew when
/// they cancelled -- needed for some captures (see `entitlement`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainCheck {
    /// The customer's app had confirmed seeing the store start before they
    /// cancelled, and the store never called the order off itself.
    ConfirmedCooking,
    /// The customer had taken (accepted) this part's driver before they
    /// cancelled, and the driver never left it.
    CustomerTook,
}

/// Whether a payee may capture a part on a basis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entitlement {
    /// They may: this much of it.
    Takes(u64),
    /// They may, this much, if the check holds.
    TakesIf(ChainCheck, u64),
    /// It isn't theirs on this basis.
    No,
}

/// Whether the recipient of `part` -- worth `amount`, for the bid
/// `part_bid` -- may take it on `basis`. The rules the ledger held a
/// recipient's collection to, unchanged; what isn't the recipient's on a
/// final basis goes back to its payer, which here is simply not capturing
/// it.
pub fn entitlement(part: &Part, amount: u64, basis: &Basis) -> Entitlement {
    use Entitlement::{No, Takes, TakesIf};
    let part_bid = match &part.purpose {
        HoldPurpose::Food => None,
        HoldPurpose::DriverPay { bid } | HoldPurpose::Subsidy { bid } | HoldPurpose::Collateral { bid } => Some(bid),
    };
    let ours = |bid: &Option<ActionHash>| part_bid.is_some() && bid.as_ref() == part_bid;
    let driver_pay = matches!(part.purpose, HoldPurpose::DriverPay { .. });
    let store_fee = matches!(part.purpose, HoldPurpose::Subsidy { .. });
    let whole = |yes: bool| if yes && amount > 0 { Takes(amount) } else { No };
    match (part.portion, basis) {
        // The food: the store's at its settlement, less the refund.
        (Portion::Food, Basis::Settled { refund }) => amount.checked_sub(*refund).filter(|left| *left > 0).map_or(No, Takes),
        (_, Basis::Settled { .. }) => No,
        // The driver who delivered it is paid; their collateral, and the
        // store's late cover, stay with whoever put them up.
        (Portion::Fee | Portion::Tip, Basis::Delivered { bid }) => whole(ours(bid)),
        (_, Basis::Delivered { .. }) => No,
        // Never arrived: the store takes the collateral for the food.
        (Portion::Collateral, Basis::NotDelivered { bid }) => whole(ours(bid)),
        (_, Basis::NotDelivered { .. }) => No,
        // A driver who called the store late leaves paid in full by it.
        (Portion::Fee | Portion::LateCover, Basis::Released { bid, store_late: true, .. }) if store_fee => whole(part_bid == Some(bid)),
        (_, Basis::Released { .. } | Basis::Replaced { .. }) => No,
        (portion, Basis::Cancelled(c)) => match c.by {
            // A customer who cancels once the store is cooking owes the food
            // -- or once they knew it was; once a driver is assigned, their
            // fee too -- or to a driver they'd taken.
            Cancellation::ByCustomer => match portion {
                Portion::Food if c.cooking && !matches!(c.from, Stage::Waiting | Stage::Other) => whole(true),
                Portion::Food => TakesIf(ChainCheck::ConfirmedCooking, amount).filter_zero(),
                Portion::Fee if driver_pay && matches!(c.from, Stage::DriverAssigned | Stage::AtStore) && ours(&c.bid) => whole(true),
                Portion::Fee if driver_pay => TakesIf(ChainCheck::CustomerTook, amount).filter_zero(),
                _ => No,
            },
            // A store calling it off with the driver at its counter pays them
            // as if it had kept them waiting.
            Cancellation::ByStore(_) => whole(store_fee && portion != Portion::Collateral && c.from == Stage::AtStore && ours(&c.bid)),
            // A customer who chose to collect it and never came owes the food.
            Cancellation::NotCollected => whole(portion == Portion::Food),
            // The store kept a driver waiting: it pays the driver it checked
            // in, in full; the customer owes nothing.
            Cancellation::StoreLate => whole(store_fee && matches!(portion, Portion::Fee | Portion::LateCover) && ours(&c.bid)),
            // No driver came: the one who left it cooking pays for the food.
            Cancellation::NoDriver => whole(portion == Portion::Collateral && c.liable.as_ref() == part_bid && part_bid.is_some()),
            // The customer saying the store never answered -- after their own
            // app confirmed it had: the store is paid for the food.
            Cancellation::StoreDidNotRespond if portion == Portion::Food => TakesIf(ChainCheck::ConfirmedCooking, amount).filter_zero(),
            Cancellation::StoreDidNotRespond => No,
        },
    }
}

impl Entitlement {
    /// Nothing to take is no entitlement at all.
    fn filter_zero(self) -> Self {
        match self {
            Entitlement::TakesIf(_, 0) | Entitlement::Takes(0) => Entitlement::No,
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{BidStatus, DeclineReason};
    use super::*;
    use std::collections::BTreeMap;

    fn agent(n: u8) -> AgentPubKey {
        AgentPubKey::from_raw_36(vec![n; 36])
    }

    fn hash(n: u8) -> ActionHash {
        ActionHash::from_raw_36(vec![n; 36])
    }

    /// Mo's customer (1) at Cara's store (2): $20 of food, a $3 tip, the
    /// store paying half of the fee, capped at $8.
    fn terms() -> OrderTerms {
        OrderTerms { requester: agent(1), merchant: agent(2), order_total: 2000, tip_cents: 300, delivery_subsidy_percent: 50, delivery: true, priority: false, fee_cap: Some(800) }
    }

    fn bid(bidder: u8, price_offer: u64) -> Bid {
        Bid { order_ref: hash(9), bidder: agent(bidder), eta_seconds: 600, to_store_seconds: 300, price_offer, collateral: 2000, status: BidStatus::Open, created_at: Timestamp::from_micros(0), verification: None }
    }

    /// Two drivers: Dana (3) bids $6, Eli (4) bids $7.
    fn bids() -> Vec<(ActionHash, Bid)> {
        vec![(hash(31), bid(3, 600)), (hash(41), bid(4, 700))]
    }

    fn cancelled(by: Cancellation, from: Stage, cooking: bool, bid: Option<ActionHash>, liable: Option<ActionHash>) -> Basis {
        Basis::Cancelled(Cancelled { by, from, cooking, bid, liable })
    }

    /// Every part an order with `bids` has: who pays it, who it's for, and
    /// what it's worth.
    fn parts(terms: &OrderTerms, bids: &[(ActionHash, Bid)]) -> Vec<(Part, Option<Bid>, AgentPubKey, AgentPubKey, u64)> {
        let mut purposes = vec![(HoldPurpose::Food, None)];
        for (hash, bid) in bids {
            for purpose in [HoldPurpose::DriverPay { bid: hash.clone() }, HoldPurpose::Subsidy { bid: hash.clone() }, HoldPurpose::Collateral { bid: hash.clone() }] {
                purposes.push((purpose, Some(bid.clone())));
            }
        }
        let mut out = Vec::new();
        for (purpose, bid) in purposes {
            let Some((payer, shares)) = hold_terms(terms, &purpose, bid.as_ref()) else { continue };
            for share in shares {
                out.push((Part { purpose: purpose.clone(), portion: share.portion }, bid.clone(), payer.clone(), share.recipient, share.amount));
            }
        }
        out
    }

    /// What the recipient of a part takes in a scenario: on the first basis
    /// that entitles them, with chain checks answering `checks`.
    fn taken(part: &Part, amount: u64, bases: &[Basis], checks: bool) -> u64 {
        for basis in bases {
            match entitlement(part, amount, basis) {
                Entitlement::Takes(n) => return n,
                Entitlement::TakesIf(_, n) if checks => return n,
                _ => {}
            }
        }
        0
    }

    /// Each party's net, as the ledger settled it: a part's recipient takes
    /// what they're entitled to; the rest stays with its payer.
    fn credits(terms: &OrderTerms, bids: &[(ActionHash, Bid)], bases: &[Basis], checks: bool) -> BTreeMap<AgentPubKey, i64> {
        let mut net = BTreeMap::new();
        for (part, _, payer, recipient, amount) in parts(terms, bids) {
            let n = taken(&part, amount, bases, checks) as i64;
            *net.entry(recipient).or_insert(0) += n;
            *net.entry(payer).or_insert(0) -= n;
        }
        net
    }

    /// Each party's net, paid directly: each leg's payee captures the parts
    /// it gathers -- never more than the leg authorizes.
    fn direct(terms: &OrderTerms, bids: &[(ActionHash, Bid)], bases: &[Basis], checks: bool) -> BTreeMap<AgentPubKey, i64> {
        let mut legs = vec![(Leg::Customer, None)];
        for (hash, bid) in bids {
            legs.push((Leg::DriverPay { bid: hash.clone() }, Some(bid.clone())));
            legs.push((Leg::Collateral { bid: hash.clone() }, Some(bid.clone())));
        }
        let all = parts(terms, bids);
        let mut net = BTreeMap::new();
        for (leg, bid) in legs {
            let (payer, payee) = leg.parties(terms, bid.as_ref()).expect("a leg of this order");
            let captured: u64 = all.iter().filter(|(part, ..)| leg.includes(part)).map(|(part, _, _, _, amount)| taken(part, *amount, bases, checks)).sum();
            let required = leg.required(terms, bid.as_ref()).expect("a payable leg");
            if payer == payee {
                assert_eq!(required, 0, "{leg:?}: nobody authorizes a payment to themselves");
                continue;
            }
            assert!(captured <= required, "{leg:?}: captures {captured} of an authorization of {required}");
            *net.entry(payee).or_insert(0) += captured as i64;
            *net.entry(payer).or_insert(0) -= captured as i64;
        }
        net.retain(|_, n| *n != 0);
        net
    }

    fn assert_same(name: &str, terms: &OrderTerms, bids: &[(ActionHash, Bid)], bases: &[Basis], checks: bool) {
        let mut before = credits(terms, bids, bases, checks);
        before.retain(|_, n| *n != 0);
        assert_eq!(direct(terms, bids, bases, checks), before, "{name}: everyone ends up as they would have on the ledger");
    }

    #[test]
    fn each_leg_authorizes_what_its_payee_could_ever_take() {
        let t = terms();
        let (_, dana) = &bids()[0];
        assert_eq!(Leg::Customer.required(&t, None), Some(2000 + 400 + 300), "food, half the $8 cap, and the tip");
        assert_eq!(Leg::DriverPay { bid: hash(31) }.required(&t, Some(dana)), Some(600 + 300), "the whole fee and the tip");
        assert_eq!(Leg::Collateral { bid: hash(31) }.required(&t, Some(dana)), Some(2000), "the food's value");
        assert_eq!(Leg::Customer.required(&OrderTerms { delivery: false, tip_cents: 0, fee_cap: None, ..t.clone() }, None), Some(2000), "a pickup: the food");
        assert_eq!(Leg::Customer.required(&OrderTerms { fee_cap: None, ..t.clone() }, None), None, "a delivery with no cap can't be paid directly");
        assert_eq!(Leg::Customer.required(&OrderTerms { merchant: agent(1), ..t.clone() }, None), Some(0), "a store ordering from itself");
        assert_eq!(Leg::DriverPay { bid: hash(31) }.required(&t, None), None, "a driver's leg needs their bid");
        assert_eq!(Leg::DriverPay { bid: hash(31) }.required(&OrderTerms { delivery: false, ..t }, Some(dana)), None, "a pickup has no driver");
    }

    #[test]
    fn a_leg_gathers_exactly_its_own_parts() {
        let dana = hash(31);
        let part = |purpose: HoldPurpose, portion: Portion| Part { purpose, portion };
        assert!(Leg::Customer.includes(&part(HoldPurpose::Food, Portion::Food)));
        assert!(Leg::Customer.includes(&part(HoldPurpose::DriverPay { bid: dana.clone() }, Portion::Tip)), "the store passes the tip on");
        assert!(!Leg::Customer.includes(&part(HoldPurpose::Subsidy { bid: dana.clone() }, Portion::Fee)), "the store's own share is the store's to pay");
        assert!(!Leg::Customer.includes(&part(HoldPurpose::Collateral { bid: dana.clone() }, Portion::Collateral)));
        assert!(Leg::DriverPay { bid: dana.clone() }.includes(&part(HoldPurpose::Subsidy { bid: dana.clone() }, Portion::LateCover)));
        assert!(!Leg::DriverPay { bid: dana.clone() }.includes(&part(HoldPurpose::DriverPay { bid: hash(41) }, Portion::Fee)), "another driver's pay");
        assert!(!Leg::DriverPay { bid: dana.clone() }.includes(&part(HoldPurpose::Food, Portion::Food)));
        assert!(Leg::Collateral { bid: dana.clone() }.includes(&part(HoldPurpose::Collateral { bid: dana.clone() }, Portion::Collateral)));
        assert!(!Leg::Collateral { bid: dana }.includes(&part(HoldPurpose::Collateral { bid: hash(41) }, Portion::Collateral)));
    }

    /// Every kind of basis, for both drivers.
    fn every_basis() -> Vec<Basis> {
        let (dana, eli) = (hash(31), hash(41));
        let mut all = vec![Basis::Settled { refund: 0 }, Basis::Settled { refund: 500 }, Basis::Settled { refund: 5000 }];
        for bid in [None, Some(dana.clone()), Some(eli.clone())] {
            all.push(Basis::Delivered { bid: bid.clone() });
            all.push(Basis::NotDelivered { bid: bid.clone() });
        }
        for bid in [dana.clone(), eli.clone()] {
            for (store_late, at_store) in [(false, false), (false, true), (true, false), (true, true)] {
                all.push(Basis::Released { bid: bid.clone(), store_late, at_store });
            }
            all.push(Basis::Replaced { bid: bid.clone() });
        }
        let bys = [Cancellation::ByCustomer, Cancellation::ByStore(DeclineReason::OutdatedPrices), Cancellation::StoreDidNotRespond, Cancellation::NotCollected, Cancellation::StoreLate, Cancellation::NoDriver];
        for by in bys {
            for from in [Stage::Waiting, Stage::Accepted, Stage::DriverAssigned, Stage::AtStore, Stage::Other] {
                for cooking in [false, true] {
                    for (bid, liable) in [(None, None), (Some(dana.clone()), None), (Some(eli.clone()), Some(dana.clone()))] {
                        all.push(cancelled(by.clone(), from, cooking, bid, liable));
                    }
                }
            }
        }
        all
    }

    #[test]
    fn no_basis_takes_more_than_a_part_is_worth() {
        for (part, _, _, _, amount) in parts(&terms(), &bids()) {
            for basis in every_basis() {
                let took = match entitlement(&part, amount, &basis) {
                    Entitlement::Takes(n) | Entitlement::TakesIf(_, n) => n,
                    Entitlement::No => 0,
                };
                assert!(took <= amount, "{part:?} on {basis:?}: {took} of {amount}");
                assert!(!matches!(entitlement(&part, amount, &basis), Entitlement::Takes(0) | Entitlement::TakesIf(_, 0)), "nothing to take is never an entitlement");
            }
        }
    }

    #[test]
    fn paying_directly_settles_every_order_as_the_ledger_did() {
        let (dana, eli) = (hash(31), hash(41));
        let t = terms();
        let one = &bids()[..1];
        let both = bids();
        /// A scenario: its name, the order, its drivers, what happened, and
        /// what the parties' chains say the customer knew.
        type Case<'a> = (&'a str, OrderTerms, &'a [(ActionHash, Bid)], Vec<Basis>, bool);
        let cases: Vec<Case> = vec![
            ("delivered", t.clone(), one, vec![Basis::Delivered { bid: Some(dana.clone()) }, Basis::Settled { refund: 0 }], false),
            ("delivered, part refunded", t.clone(), one, vec![Basis::Delivered { bid: Some(dana.clone()) }, Basis::Settled { refund: 500 }], false),
            ("delivered, all refunded", t.clone(), one, vec![Basis::Delivered { bid: Some(dana.clone()) }, Basis::Settled { refund: 2000 }], false),
            ("delivered, store pays the whole fee", OrderTerms { delivery_subsidy_percent: 100, ..t.clone() }, one, vec![Basis::Delivered { bid: Some(dana.clone()) }, Basis::Settled { refund: 0 }], false),
            ("delivered, customer pays the whole fee", OrderTerms { delivery_subsidy_percent: 0, ..t.clone() }, one, vec![Basis::Delivered { bid: Some(dana.clone()) }, Basis::Settled { refund: 0 }], false),
            ("delivered, no tip", OrderTerms { tip_cents: 0, ..t.clone() }, one, vec![Basis::Delivered { bid: Some(dana.clone()) }, Basis::Settled { refund: 0 }], false),
            ("a store ordering from itself", OrderTerms { merchant: agent(1), ..t.clone() }, one, vec![Basis::Delivered { bid: Some(dana.clone()) }, Basis::Settled { refund: 0 }], false),
            ("customer cancels while waiting", t.clone(), one, vec![cancelled(Cancellation::ByCustomer, Stage::Waiting, false, None, None)], false),
            ("customer cancels once accepted, not cooking", t.clone(), one, vec![cancelled(Cancellation::ByCustomer, Stage::Accepted, false, None, None)], false),
            ("customer cancels while it cooks", t.clone(), one, vec![cancelled(Cancellation::ByCustomer, Stage::Accepted, true, None, None)], false),
            ("customer cancels, knowing it cooked", t.clone(), one, vec![cancelled(Cancellation::ByCustomer, Stage::Waiting, false, None, None)], true),
            ("customer cancels with a driver on the way", t.clone(), one, vec![cancelled(Cancellation::ByCustomer, Stage::DriverAssigned, true, Some(dana.clone()), None)], false),
            ("customer cancels with the driver at the counter", t.clone(), one, vec![cancelled(Cancellation::ByCustomer, Stage::AtStore, true, Some(dana.clone()), None)], false),
            ("customer cancels, owing a driver they'd taken", t.clone(), &both[..], vec![cancelled(Cancellation::ByCustomer, Stage::DriverAssigned, true, Some(eli.clone()), None)], true),
            ("store declines", t.clone(), one, vec![cancelled(Cancellation::ByStore(DeclineReason::OutdatedPrices), Stage::Waiting, false, None, None)], false),
            ("store calls it off with the driver at its counter", t.clone(), one, vec![cancelled(Cancellation::ByStore(DeclineReason::OutdatedPrices), Stage::AtStore, true, Some(dana.clone()), None)], false),
            ("store never answered", t.clone(), one, vec![cancelled(Cancellation::StoreDidNotRespond, Stage::Waiting, false, None, None)], false),
            ("store never answered, after the customer saw it start", t.clone(), one, vec![cancelled(Cancellation::StoreDidNotRespond, Stage::Waiting, false, None, None)], true),
            ("customer never came to collect it", t.clone(), one, vec![cancelled(Cancellation::NotCollected, Stage::Accepted, true, None, None)], false),
            ("store kept the driver waiting", t.clone(), one, vec![cancelled(Cancellation::StoreLate, Stage::AtStore, true, Some(dana.clone()), None)], false),
            ("a driver left it cooking and none came", t.clone(), one, vec![Basis::Released { bid: dana.clone(), store_late: false, at_store: false }, cancelled(Cancellation::NoDriver, Stage::Accepted, true, None, Some(dana.clone()))], false),
            ("never arrived", t.clone(), one, vec![Basis::NotDelivered { bid: Some(dana.clone()) }], false),
            ("first driver called the store late, a second delivered", t.clone(), &both[..], vec![Basis::Released { bid: dana.clone(), store_late: true, at_store: true }, Basis::Delivered { bid: Some(eli.clone()) }, Basis::Settled { refund: 0 }], false),
            ("first driver left, replaced, a second delivered", t.clone(), &both[..], vec![Basis::Released { bid: dana.clone(), store_late: false, at_store: false }, Basis::Replaced { bid: dana.clone() }, Basis::Delivered { bid: Some(eli.clone()) }, Basis::Settled { refund: 300 }], false),
            ("pickup collected", OrderTerms { delivery: false, tip_cents: 0, fee_cap: None, ..t.clone() }, &[], vec![Basis::Settled { refund: 0 }], false),
            ("pickup cancelled while it cooks", OrderTerms { delivery: false, tip_cents: 0, fee_cap: None, ..t.clone() }, &[], vec![cancelled(Cancellation::ByCustomer, Stage::Accepted, true, None, None)], false),
            ("pickup declined", OrderTerms { delivery: false, tip_cents: 0, fee_cap: None, ..t }, &[], vec![cancelled(Cancellation::ByStore(DeclineReason::OutdatedPrices), Stage::Waiting, false, None, None)], false),
        ];
        for (name, terms, bids, bases, checks) in &cases {
            assert_same(name, terms, bids, bases, *checks);
        }
    }

    #[test]
    fn the_store_keeps_nothing_of_a_drivers_money() {
        // Delivered by Dana: the customer's fee share and tip reach Dana in
        // full, through the store, which is left with the food less its own
        // share of the fee.
        let dana = hash(31);
        let net = direct(&terms(), &bids()[..1], &[Basis::Delivered { bid: Some(dana) }, Basis::Settled { refund: 0 }], false);
        assert_eq!(net.get(&agent(1)), Some(&-(2000 + 300 + 300)), "the customer: food, their half of the $6 fee, the tip");
        assert_eq!(net.get(&agent(3)), Some(&(600 + 300)), "Dana: the whole fee and the tip");
        assert_eq!(net.get(&agent(2)), Some(&(2000 - 300)), "the store: the food, less its half of the fee");
    }
}
