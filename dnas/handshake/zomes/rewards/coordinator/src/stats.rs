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
    let types = [EntryType::try_from(UnitEntryTypes::MemberOrder)?];
    let mut members: Vec<(AgentPubKey, bool)> = Vec::new();
    let mut stats = ProgramStats::default();
    for record in mine(&types).records()? {
        let Some(m) = decode_or::<MemberOrder>(&record).filter(|m| m.catalog_ref == catalog_ref) else { continue };
        stats.orders += 1;
        stats.redemptions += u32::from(m.reward.is_some());
        let recent = now - record.action().timestamp().as_micros() <= 30 * 86_400_000_000;
        match members.iter_mut().find(|(c, _)| c == &m.customer) {
            Some((_, active)) => *active |= recent,
            None => members.push((m.customer, recent)),
        }
    }
    stats.members = members.len() as u32;
    stats.active_members = members.iter().filter(|(_, a)| *a).count() as u32;
    Ok(stats)
}
