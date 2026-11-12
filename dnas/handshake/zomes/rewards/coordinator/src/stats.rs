//! A store's view of its program: how many members, orders and points.

use super::*;

/// How a store's program is doing, from its own private records.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ProgramStats {
    /// Members who've ordered under it.
    pub members: u32,
    /// Of them, those who ordered in the last 30 days.
    pub active_members: u32,
    /// Orders placed under it.
    pub orders: u32,
    /// Rewards redeemed.
    pub redemptions: u32,
}

#[hdk_extern]
pub fn program_stats(catalog_ref: ActionHash) -> ExternResult<ProgramStats> {
    let now = sys_time()?.as_micros();
    let owner = store(&catalog_ref)?.owner;
    let mut stats = ProgramStats::default();
    // From the store's public list of members and its links to their
    // orders: the same after a restore as before it.
    for (member, _) in store_members(&catalog_ref)? {
        let links = member_order_links(&member, &catalog_ref, &owner, None)?;
        stats.members += 1;
        stats.active_members += u32::from(links.iter().any(|l| now - l.timestamp.as_micros() <= 30 * 86_400_000_000));
        for link in links {
            stats.orders += 1;
            let Some((_, order)) = parse_member_order_tag(&link.tag.0) else { continue };
            let redeemed = get(order, GetOptions::default())?.as_ref().and_then(OrderForRewards::of).is_some_and(|o| o.rewards.is_some_and(|r| r.reward.is_some()));
            stats.redemptions += u32::from(redeemed);
        }
    }
    Ok(stats)
}
