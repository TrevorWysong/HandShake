use serde::{Deserialize, Serialize};

/// A larger share of the delivery fee a store covers from an order size up
/// (`MerchantCatalog::delivery_subsidy_tiers`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SubsidyTier {
    /// From this much food, in minor units -- after any discount, before
    /// tax is added (`fee_basis`).
    pub from_cents: u64,
    /// The share of the fee the store covers there, 0-100.
    pub percent: u8,
}

/// The most tiers a store's delivery share has.
pub const MAX_SUBSIDY_TIERS: usize = 4;

/// What a store's delivery share is measured against: the food as the
/// customer pays for it -- after any promo or reward, before tax is added
/// (in prices that already include it, as shown).
pub fn fee_basis(order_total: u64, tax_cents: u64, prices_include_tax: bool) -> u64 {
    if prices_include_tax {
        order_total
    } else {
        order_total.saturating_sub(tax_cents)
    }
}

/// The share of the delivery fee covered on an order whose food comes to
/// `basis`: the highest tier it reaches, or `base`.
pub fn share_at(base: u8, tiers: &[SubsidyTier], basis: u64) -> u8 {
    tiers.iter().rev().find(|tier| basis >= tier.from_cents).map_or(base, |tier| tier.percent)
}

/// What's wrong with a delivery share, if anything: every share between 0
/// and 100, and each tier for a larger order than the last, covering more
/// than it.
pub fn problem(base: u8, tiers: &[SubsidyTier]) -> Option<&'static str> {
    if base > 100 {
        return Some("delivery_subsidy_percent must be between 0 and 100");
    }
    if tiers.len() > MAX_SUBSIDY_TIERS {
        return Some("a store's delivery share has at most 4 tiers");
    }
    let mut last = (0u64, base);
    for tier in tiers {
        if tier.percent > 100 {
            return Some("a delivery share is between 0 and 100 percent");
        }
        if tier.from_cents <= last.0 || tier.percent <= last.1 {
            return Some("each delivery share tier is for larger orders than the last, and covers more");
        }
        last = (tier.from_cents, tier.percent);
    }
    None
}

/// Whether `a` covers more of the delivery fee than `b` on an order of
/// some size: both are steps, so it's enough to look where either steps.
pub fn covers_more(a: (u8, &[SubsidyTier]), b: (u8, &[SubsidyTier])) -> bool {
    let steps = std::iter::once(0).chain(a.1.iter().chain(b.1).map(|tier| tier.from_cents));
    steps.into_iter().any(|basis| share_at(a.0, a.1, basis) > share_at(b.0, b.1, basis))
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn tier(from_cents: u64, percent: u8) -> SubsidyTier {
        SubsidyTier { from_cents, percent }
    }

    #[test]
    fn a_share_steps_up_at_each_tier_it_reaches() {
        let tiers = [tier(1500, 75), tier(2500, 100)];
        assert_eq!(share_at(50, &tiers, 0), 50);
        assert_eq!(share_at(50, &tiers, 1499), 50);
        assert_eq!(share_at(50, &tiers, 1500), 75, "from its order size, not above it");
        assert_eq!(share_at(50, &tiers, 2499), 75);
        assert_eq!(share_at(50, &tiers, 9999), 100, "free delivery on the largest");
        assert_eq!(share_at(30, &[], 9999), 30, "no tiers: the base share on every order");
    }

    #[test]
    fn tiers_grow_in_order_size_and_share() {
        assert_eq!(problem(50, &[tier(1500, 75), tier(2500, 100)]), None);
        assert_eq!(problem(0, &[tier(2500, 100)]), None, "free delivery over $25, nothing below");
        assert!(problem(101, &[]).is_some());
        assert!(problem(50, &[tier(0, 75)]).is_some(), "a tier is for a larger order than any");
        assert!(problem(50, &[tier(1500, 50)]).is_some(), "a tier covers more than the base");
        assert!(problem(50, &[tier(2500, 75), tier(1500, 100)]).is_some(), "smallest first");
        assert!(problem(50, &[tier(1500, 100), tier(2500, 90)]).is_some(), "never less for more");
        assert!(problem(50, &[tier(1500, 101)]).is_some());
        assert!(problem(10, &[tier(100, 20), tier(200, 30), tier(300, 40), tier(400, 50), tier(500, 60)]).is_some(), "at most four");
    }

    #[test]
    fn covering_more_is_more_at_any_order_size() {
        let free_over_25 = [tier(2500, 100)];
        assert!(covers_more((50, &free_over_25), (50, &[])), "free on large orders");
        assert!(!covers_more((50, &[]), (50, &free_over_25)));
        assert!(covers_more((50, &[tier(2000, 100)]), (50, &free_over_25)), "free from a smaller order");
        assert!(!covers_more((50, &free_over_25), (50, &free_over_25)));
        assert!(covers_more((60, &[]), (50, &free_over_25)), "more on small orders, though less on large");
    }
}
