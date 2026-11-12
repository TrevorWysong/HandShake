//! A store's rewards program and its customers' points, factored out of
//! `rewards_integrity` so other zomes' validation (an order redeeming a
//! reward) can decode them -- same reasoning as `ledger_types`.
//!
//! The model (docs/REWARDS.md):
//!
//! - **A program is its store's own.** Its owner writes it and changes it
//!   by updating it. Every order cites the version it was placed under,
//!   which fixes what it earns and what its reward costs. The store's app
//!   refuses an order citing a version that's been replaced, as it does an
//!   order priced from an old menu.
//! - **Points are private, between a member and a store.** No points ledger
//!   is published. A member's points at a store follow from what the store
//!   itself holds: the orders it accepted from them that joined its program
//!   (linked from the member, `MemberToOrder`), its settlements of them once their
//!   refund period is over, the rewards it accepted, and its own grants
//!   (sealed to the member). The store works them out with the pure rules
//!   in `points` before honouring a reward; the member's app works out the
//!   same from its own orders, to show them.
//! - **Points come only from what was paid, or from the store.** Earning
//!   rests on the store's own settlement; anything else is the store's own
//!   grant, which costs only it.
//! - **Points leave only into an order the store accepts.** An order names
//!   the reward it spends; its price must reflect exactly that reward
//!   (`dispatch_integrity`); and the store accepts it only if the member's
//!   points cover it. An order cancelled before the store accepts spends
//!   nothing; one whose food the store gives back returns what it spent.

use catalog_types::PromoReward;
use hdi::prelude::*;

pub mod earn;
pub mod ledger;
pub mod points;

// The private records a running total is kept in (`ledger`).
pub use ledger::{KeptRecord, KeptVersion, MemberAccount, MemberBirthdays, MemberStores};

pub use earn::*;
pub use points::*;

/// The most rewards a program offers.
pub const MAX_REWARDS: usize = 24;
/// The most tiers above the base one.
pub const MAX_TIERS: usize = 4;
/// The most menu items with their own earn rate.
pub const MAX_ITEM_BONUSES: usize = 20;
/// The most happy hours.
pub const MAX_HAPPY_HOURS: usize = 7;
/// The most points anything holds, costs or grants -- far beyond any real
/// program, and far below where arithmetic could overflow.
pub const MAX_POINTS: u64 = 1_000_000_000;
/// The most a single reward costs.
pub const MAX_REWARD_COST: u32 = 1_000_000;
/// The most a store grants at once, or welcomes or celebrates with.
pub const MAX_GRANT_POINTS: u32 = 100_000;
/// Points per dollar of food, at most.
pub const MAX_POINTS_PER_DOLLAR: u16 = 100;
/// A multiplier, in percent: an item's at most 10x, a happy hour's 5x, a
/// tier's 3x. Each at least 1x.
pub const MAX_ITEM_PERCENT: u16 = 1_000;
pub const MAX_HAPPY_PERCENT: u16 = 500;
pub const MAX_TIER_PERCENT: u16 = 300;
/// The fewest and most days points last without an order.
pub const MIN_EXPIRY_DAYS: u16 = 30;
pub const MAX_EXPIRY_DAYS: u16 = 1_095;
/// The most units a reward's item part covers.
pub const MAX_REWARD_QUANTITY: u32 = 10;
/// How long before its order a redemption may be written, at most, in
/// seconds: an honest app writes both in one commit.
pub const REDEMPTION_WINDOW_SECS: i64 = 3_600;
/// The shortest a program's text fields may be, and the longest.
pub const MAX_PROGRAM_NAME_CHARS: usize = 40;
pub const MAX_POINTS_NAME_CHARS: usize = 20;
pub const MAX_TAGLINE_CHARS: usize = 120;
pub const MAX_REWARD_NAME_CHARS: usize = 60;
pub const MAX_TIER_NAME_CHARS: usize = 24;
pub const MAX_PERK_CHARS: usize = 120;
pub const MAX_GRANT_NOTE_CHARS: usize = 200;
/// The most a sealed grant may weigh.
pub const MAX_SEALED_GRANT_BYTES: usize = 1_024;
/// The most a list of grants one entry carries may weigh, unsealed (a
/// `GiftReveal`, `CarriedGifts`): half of what Holochain lets an entry
/// weigh, the rest left for the boxes and the entry around them. A longer
/// list goes in as many entries as it takes, so none is ever cut short.
pub const MAX_GIFT_LIST_BYTES: usize = 2_000_000;
const _: () = assert!(MAX_GIFT_LIST_BYTES * 2 == ENTRY_SIZE_LIMIT, "half of what Holochain lets an entry weigh");

/// A store's rewards program, as one version of it stands.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct RewardsProgram {
    /// The store (its original action).
    pub catalog_ref: ActionHash,
    /// Whether it's running: an order earns, and redeems, only under an
    /// active version. Points already earned stay.
    pub active: bool,
    /// "Mo's Rewards".
    pub name: String,
    /// What its points are called ("points", "beans", "stars").
    pub points_name: String,
    /// A line for its card ("Every bowl gets you closer to a free one").
    pub tagline: String,
    pub accent: Accent,
    pub earn: EarnRules,
    /// Status above the base tier, lowest first: reached by points earned
    /// in a calendar year, kept through the next.
    pub tiers: Vec<Tier>,
    /// What points buy.
    pub rewards: Vec<Reward>,
    /// What the store gives in a member's birthday month, once a year --
    /// none if 0. Granted by the store's app (`PointsGrant`).
    pub birthday_points: u32,
    /// Points left without an order this many days expire. `None`: never.
    pub expiry_days: Option<u16>,
    /// The most a member holds; what's earned past it is lost. `None`: no
    /// limit but `MAX_POINTS`.
    pub max_balance: Option<u64>,
    /// The IANA time zone its hours, years and birthdays are in
    /// ("America/New_York").
    pub time_zone: String,
}

/// The colour a program's card is drawn in.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accent {
    Ember,
    Citrus,
    Forest,
    Ocean,
    Berry,
    Midnight,
}

/// How points are earned.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct EarnRules {
    /// Points per dollar of food paid -- after discounts and any refund,
    /// before tax.
    pub points_per_dollar: u16,
    /// Food below this earns nothing.
    pub min_order_cents: u64,
    /// The most one order earns, before any welcome. `None`: no cap.
    pub max_per_order: Option<u32>,
    /// Added to a member's first order here.
    pub welcome_bonus: u32,
    /// Items that earn faster.
    pub item_bonuses: Vec<ItemBonus>,
    /// Times that earn faster.
    pub happy_hours: Vec<HappyHour>,
}

/// A menu item earning at `percent` of the usual rate (200: double).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ItemBonus {
    /// The item (its original action).
    pub item_ref: ActionHash,
    pub percent: u16,
}

/// A window each week earning at `percent` of the usual rate.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct HappyHour {
    /// Which days: bit 0 Monday ... bit 6 Sunday.
    pub days: u8,
    /// Minutes after local midnight it starts, and ends (exclusive).
    pub start_minute: u16,
    pub end_minute: u16,
    pub percent: u16,
}

/// A status level.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Tier {
    /// "Gold".
    pub name: String,
    /// Points earned in a calendar year that reach it.
    pub threshold: u64,
    /// What it earns at, in percent of the usual rate (150: 1.5x).
    pub percent: u16,
    /// What else it brings, in words ("Free guac, always").
    pub perk: String,
}

/// Something points buy.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Reward {
    /// Its identity across versions of the program, unique within one.
    pub id: u16,
    /// "Free chips & guac".
    pub name: String,
    pub cost: u32,
    /// What it takes off the order -- a promo's shapes, priced the same way
    /// (`catalog_types::pricing`).
    pub benefit: PromoReward,
    /// The tier it needs: 0 for everyone, 1 for the first tier above, ...
    pub min_tier: u8,
}

/// Points a store gives a member: a welcome back, a birthday, an apology.
/// What it gives is sealed between the two (`GrantPayload`); whom it's to,
/// from which store, and an order they placed there are public -- so only a
/// store's own customers can be sent one, and nobody can fill a stranger's
/// inbox with them. The store counts its own grants when it works out a
/// member's points; the member's app, opening it, knows it's the store's
/// (a sealed box names its sender).
///
/// `commitment` is a salted hash of what it says (`grant_commitment`):
/// it gives nothing away, but lets the member show a grant to someone it
/// wasn't sealed to -- the store's next key, or its store on the next
/// network -- who can tell it's what the store said (`RevealedGrant`).
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct PointsGrant {
    pub to: AgentPubKey,
    /// The store giving it, by its original action.
    pub catalog_ref: ActionHash,
    /// An order `to` placed there (its original action).
    pub order: ActionHash,
    pub sealed: XSalsa20Poly1305EncryptedData,
    pub commitment: Vec<u8>,
}

/// What a `PointsGrant` says, sealed.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct GrantPayload {
    pub points: u32,
    pub reason: GrantReason,
    /// Random, so its commitment can't be guessed by trying every amount.
    pub salt: Vec<u8>,
}

/// The bytes of salt a grant's payload carries.
pub const GRANT_SALT_BYTES: usize = 16;

/// A grant's commitment to `payload`: a hash of who it's to, from which
/// store, and what it says, salt and all.
pub fn grant_commitment(to: &AgentPubKey, catalog_ref: &ActionHash, payload: &GrantPayload) -> ExternResult<Vec<u8>> {
    let said = holochain_serialized_bytes::encode(payload).map_err(|e| wasm_error!(WasmErrorInner::Serialize(e)))?;
    let bytes = [b"handshake-grant:v1:".as_slice(), to.get_raw_39(), catalog_ref.get_raw_39(), &said].concat();
    Ok(hdi::prelude::holo_hash::encode::blake2b_256(&bytes))
}

/// A grant shown by the member it's to, to a store it wasn't sealed to:
/// the grant (its action), and what it said. True if it matches the
/// grant's commitment (`RevealedGrant::proves`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct RevealedGrant {
    pub grant: ActionHash,
    pub payload: GrantPayload,
}

impl RevealedGrant {
    /// Whether `grant`, the record it names, says what it reveals.
    pub fn proves(&self, grant: &PointsGrant) -> bool {
        grant_commitment(&grant.to, &grant.catalog_ref, &self.payload).is_ok_and(|c| c == grant.commitment)
    }
}

/// A member showing the store `catalog_ref`'s owner grants they were given
/// by an earlier key of the store (one lost, then recovered), or by its
/// store on the network before (a migration): `Vec<RevealedGrant>`, sealed
/// to the owner. The store counts each one it can prove; so does the
/// member's card, alike.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GiftReveal {
    pub catalog_ref: ActionHash,
    pub sealed: handshake_integrity_support::SealedChunks,
}

/// Every grant a member was given here, sealed to their key on the next
/// network as their account leaves this one: `Vec<CarriedGift>`. Their new
/// key reads it here, through its `previous` role, and shows each store
/// that came over the grants it gave them (`GiftReveal`).
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CarriedGifts {
    pub sealed: handshake_integrity_support::SealedChunks,
}

/// A grant carried to the next network: the store that gave it, and the
/// grant shown.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CarriedGift {
    pub catalog_ref: ActionHash,
    pub revealed: RevealedGrant,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum GrantReason {
    /// The store's own word ("Sorry about the wait!").
    Goodwill { note: String },
    /// A member's birthday month, in `year`.
    Birthday { year: i32 },
    /// What the member held at the store `from` on the network before this
    /// one, carried over when the store moved here (docs/MIGRATION.md).
    Carried { from: ActionHash },
}

/// The month a member was born in -- kept on their own device only
/// (a private entry), to tell the stores they choose (`BirthdayShare`).
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct BirthMonth {
    /// 1 (January) to 12.
    pub month: u8,
}

/// A member telling one store their birth month, sealed to its owner -- so
/// only that store learns it. The store takes the first a member sends it.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct BirthdayShare {
    pub catalog_ref: ActionHash,
    /// An order its author placed there (its original action): only a
    /// store's own customers tell it anything.
    pub order: ActionHash,
    /// The month (1-12, one byte), sealed to the store's owner.
    pub sealed_month: XSalsa20Poly1305EncryptedData,
}

/// The tag on a store's link from a member to its acceptance of one of
/// their orders (`MemberToOrder`): the store, then the order -- so a read
/// filters to one store, or to one order, by prefix.
pub fn member_order_tag(catalog_ref: &ActionHash, order: &ActionHash) -> Vec<u8> {
    [catalog_ref.get_raw_39(), order.get_raw_39()].concat()
}

/// A `member_order_tag`'s store and order.
pub fn parse_member_order_tag(tag: &[u8]) -> Option<(ActionHash, ActionHash)> {
    (tag.len() == 78).then(|| (ActionHash::from_raw_39(tag[..39].to_vec()), ActionHash::from_raw_39(tag[39..].to_vec())))
}

impl RewardsProgram {
    /// A reward by its id.
    pub fn reward(&self, id: u16) -> Option<&Reward> {
        self.rewards.iter().find(|r| r.id == id)
    }

    /// The most a member holds.
    pub fn cap(&self) -> u64 {
        self.max_balance.unwrap_or(MAX_POINTS).min(MAX_POINTS)
    }

    /// What's wrong with it, if anything, that can be told from the entry
    /// alone. (That its items are its store's, and its author owns the
    /// store, validation checks against the records.)
    pub fn problem(&self) -> Option<String> {
        use handshake_integrity_support::text_problem;
        let texts = [
            text_problem("name", &self.name, MAX_PROGRAM_NAME_CHARS),
            text_problem("points_name", &self.points_name, MAX_POINTS_NAME_CHARS),
            text_problem("tagline", &self.tagline, MAX_TAGLINE_CHARS),
        ];
        if let Some(problem) = texts.into_iter().flatten().next() {
            return Some(problem);
        }
        if self.name.trim().is_empty() || self.points_name.trim().is_empty() {
            return Some("a program has a name, and a name for its points".into());
        }
        if self.time_zone.parse::<chrono_tz::Tz>().is_err() {
            return Some("a program's time zone is an IANA zone".into());
        }
        let earn = &self.earn;
        if earn.points_per_dollar == 0 || earn.points_per_dollar > MAX_POINTS_PER_DOLLAR {
            return Some(format!("a program earns between 1 and {MAX_POINTS_PER_DOLLAR} points a dollar"));
        }
        if handshake_integrity_support::amount_problem("min_order_cents", earn.min_order_cents).is_some() {
            return Some("min_order_cents is out of range".into());
        }
        if earn.max_per_order.is_some_and(|max| max == 0 || u64::from(max) > MAX_POINTS) {
            return Some("an order's cap on points is more than nothing".into());
        }
        if earn.welcome_bonus > MAX_GRANT_POINTS || self.birthday_points > MAX_GRANT_POINTS {
            return Some(format!("a welcome or birthday is at most {MAX_GRANT_POINTS} points"));
        }
        if earn.item_bonuses.len() > MAX_ITEM_BONUSES {
            return Some(format!("at most {MAX_ITEM_BONUSES} items earn faster"));
        }
        for (i, bonus) in earn.item_bonuses.iter().enumerate() {
            if bonus.percent <= 100 || bonus.percent > MAX_ITEM_PERCENT {
                return Some(format!("an item earns faster: between 101% and {MAX_ITEM_PERCENT}% of the usual rate"));
            }
            if earn.item_bonuses[..i].iter().any(|b| b.item_ref == bonus.item_ref) {
                return Some("each item earns at one rate".into());
            }
        }
        if earn.happy_hours.len() > MAX_HAPPY_HOURS {
            return Some(format!("at most {MAX_HAPPY_HOURS} happy hours"));
        }
        for hour in &earn.happy_hours {
            if hour.days == 0 || hour.days > 0b111_1111 || hour.start_minute >= hour.end_minute || hour.end_minute > 24 * 60 {
                return Some("a happy hour falls on some days, between a start and a later end on the same day".into());
            }
            if hour.percent <= 100 || hour.percent > MAX_HAPPY_PERCENT {
                return Some(format!("a happy hour earns between 101% and {MAX_HAPPY_PERCENT}% of the usual rate"));
            }
        }
        if self.tiers.len() > MAX_TIERS {
            return Some(format!("at most {MAX_TIERS} tiers"));
        }
        for (i, tier) in self.tiers.iter().enumerate() {
            if let Some(problem) = text_problem("tier name", &tier.name, MAX_TIER_NAME_CHARS).or_else(|| text_problem("perk", &tier.perk, MAX_PERK_CHARS)) {
                return Some(problem);
            }
            if tier.name.trim().is_empty() {
                return Some("a tier has a name".into());
            }
            let floor = if i == 0 { 0 } else { self.tiers[i - 1].threshold };
            if tier.threshold <= floor || tier.threshold > MAX_POINTS {
                return Some("each tier takes more points than the one below it".into());
            }
            let below = if i == 0 { 100 } else { self.tiers[i - 1].percent };
            if tier.percent < below || tier.percent > MAX_TIER_PERCENT {
                return Some(format!("each tier earns at least as fast as the one below, and at most {MAX_TIER_PERCENT}%"));
            }
        }
        if self.rewards.len() > MAX_REWARDS {
            return Some(format!("at most {MAX_REWARDS} rewards"));
        }
        for (i, reward) in self.rewards.iter().enumerate() {
            if let Some(problem) = text_problem("reward name", &reward.name, MAX_REWARD_NAME_CHARS) {
                return Some(problem);
            }
            if reward.name.trim().is_empty() {
                return Some("a reward has a name".into());
            }
            if self.rewards[..i].iter().any(|r| r.id == reward.id) {
                return Some("each reward has its own id".into());
            }
            if reward.cost == 0 || reward.cost > MAX_REWARD_COST {
                return Some(format!("a reward costs between 1 and {MAX_REWARD_COST} points"));
            }
            if usize::from(reward.min_tier) > self.tiers.len() {
                return Some("a reward needs a tier the program has".into());
            }
            if let Some(problem) = benefit_problem(&reward.benefit) {
                return Some(problem.into());
            }
        }
        if let Some(max) = self.max_balance {
            let dearest = self.rewards.iter().map(|r| u64::from(r.cost)).max().unwrap_or(1);
            if max < dearest || max > MAX_POINTS {
                return Some("a member can hold at least enough for the dearest reward".into());
            }
        }
        if self.expiry_days.is_some_and(|days| !(MIN_EXPIRY_DAYS..=MAX_EXPIRY_DAYS).contains(&days)) {
            return Some(format!("points last between {MIN_EXPIRY_DAYS} and {MAX_EXPIRY_DAYS} days without an order"));
        }
        None
    }

    /// Every menu item it names, for validation to check are its store's.
    /// The program for another store's copies of its items and choice groups
    /// (each original to its copy): for a store republished by its owner's
    /// new key, or on a new network. A bonus or reward naming something not
    /// copied is left out.
    pub fn remapped(&self, catalog_ref: ActionHash, item: impl Fn(&ActionHash) -> Option<ActionHash>, group: impl Fn(&ActionHash) -> Option<ActionHash>) -> Self {
        let mut program = self.clone();
        program.catalog_ref = catalog_ref;
        program.earn.item_bonuses = self.earn.item_bonuses.iter().filter_map(|b| Some(ItemBonus { item_ref: item(&b.item_ref)?, ..b.clone() })).collect();
        program.rewards = self.rewards.iter().filter_map(|r| Some(Reward { benefit: r.benefit.remapped(&item, &group)?, ..r.clone() })).collect();
        program
    }

    pub fn items(&self) -> Vec<&ActionHash> {
        let mut items: Vec<&ActionHash> = self.earn.item_bonuses.iter().map(|b| &b.item_ref).collect();
        for reward in &self.rewards {
            match &reward.benefit {
                PromoReward::FreeItem { item_ref, .. } | PromoReward::PercentOffItem { item_ref, .. } => items.push(item_ref),
                _ => {}
            }
        }
        items
    }
}

/// What's wrong with what a reward takes off, if anything.
pub fn benefit_problem(benefit: &PromoReward) -> Option<&'static str> {
    match benefit {
        PromoReward::PercentOffSubtotal(p) if *p == 0 || *p > 100 => Some("a reward takes between 1% and 100% off"),
        PromoReward::FlatOffSubtotal(cents) if *cents == 0 || handshake_integrity_support::amount_problem("cents", *cents).is_some() => Some("a reward takes more than nothing off"),
        PromoReward::FreeItem { quantity, .. } if *quantity == 0 || *quantity > MAX_REWARD_QUANTITY => Some("a reward's free items number between one and ten"),
        PromoReward::PercentOffItem { percent, quantity, .. } if *percent == 0 || *percent > 100 || *quantity == 0 || *quantity > MAX_REWARD_QUANTITY => Some("a reward takes between 1% and 100% off between one and ten items"),
        PromoReward::FreeItem { choices, .. } | PromoReward::PercentOffItem { choices, .. } => catalog_types::choice_terms_problem(choices),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(n: u8) -> ActionHash {
        ActionHash::from_raw_36(vec![n; 36])
    }

    pub(crate) fn program() -> RewardsProgram {
        RewardsProgram {
            catalog_ref: hash(1),
            active: true,
            name: "Mo's Rewards".into(),
            points_name: "points".into(),
            tagline: String::new(),
            accent: Accent::Ember,
            earn: EarnRules { points_per_dollar: 10, min_order_cents: 0, max_per_order: None, welcome_bonus: 0, item_bonuses: Vec::new(), happy_hours: Vec::new() },
            tiers: Vec::new(),
            rewards: vec![Reward { id: 1, name: "Free soup".into(), cost: 100, benefit: PromoReward::FreeItem { item_ref: hash(9), quantity: 1, choices: Vec::new() }, min_tier: 0 }],
            birthday_points: 0,
            expiry_days: None,
            max_balance: None,
            time_zone: "America/New_York".into(),
        }
    }

    #[test]
    fn a_sound_program_passes() {
        assert_eq!(program().problem(), None);
    }

    #[test]
    fn every_limit_is_checked() {
        let bad = |change: &dyn Fn(&mut RewardsProgram)| {
            let mut p = program();
            change(&mut p);
            p.problem()
        };
        assert!(bad(&|p| p.name = " ".into()).is_some(), "a name");
        assert!(bad(&|p| p.time_zone = "Mars/Olympus".into()).is_some(), "a real time zone");
        assert!(bad(&|p| p.earn.points_per_dollar = 0).is_some());
        assert!(bad(&|p| p.earn.points_per_dollar = 101).is_some());
        assert!(bad(&|p| p.earn.max_per_order = Some(0)).is_some());
        assert!(bad(&|p| p.earn.welcome_bonus = MAX_GRANT_POINTS + 1).is_some());
        assert!(bad(&|p| p.earn.item_bonuses = vec![ItemBonus { item_ref: hash(2), percent: 100 }]).is_some(), "a bonus is faster");
        assert!(bad(&|p| p.earn.item_bonuses = vec![ItemBonus { item_ref: hash(2), percent: 200 }, ItemBonus { item_ref: hash(2), percent: 300 }]).is_some(), "one rate an item");
        assert!(bad(&|p| p.earn.happy_hours = vec![HappyHour { days: 1, start_minute: 600, end_minute: 600, percent: 200 }]).is_some(), "an hour ends after it starts");
        assert!(bad(&|p| p.earn.happy_hours = vec![HappyHour { days: 0, start_minute: 0, end_minute: 60, percent: 200 }]).is_some(), "on some day");
        assert!(bad(&|p| p.earn.happy_hours = vec![HappyHour { days: 1, start_minute: 0, end_minute: 60, percent: 501 }]).is_some());
        let tier = |name: &str, threshold, percent| Tier { name: name.into(), threshold, percent, perk: String::new() };
        assert!(bad(&|p| p.tiers = vec![tier("Gold", 0, 120)]).is_some(), "a tier takes points");
        assert!(bad(&|p| p.tiers = vec![tier("Silver", 500, 120), tier("Gold", 500, 150)]).is_some(), "ascending");
        assert!(bad(&|p| p.tiers = vec![tier("Silver", 500, 150), tier("Gold", 900, 120)]).is_some(), "never slower above");
        assert!(bad(&|p| p.tiers = vec![tier("Gold", 500, 301)]).is_some());
        assert!(bad(&|p| p.rewards[0].cost = 0).is_some());
        assert!(bad(&|p| p.rewards[0].min_tier = 1).is_some(), "a tier it has");
        assert!(bad(&|p| p.rewards.push(p.rewards[0].clone())).is_some(), "unique ids");
        assert!(bad(&|p| p.rewards[0].benefit = PromoReward::FreeItem { item_ref: hash(9), quantity: 11, choices: Vec::new() }).is_some());
        assert!(bad(&|p| p.rewards[0].benefit = PromoReward::PercentOffSubtotal(0)).is_some());
        assert!(bad(&|p| p.max_balance = Some(99)).is_some(), "room for the dearest reward");
        assert!(bad(&|p| p.expiry_days = Some(29)).is_some());
        assert!(bad(&|p| p.expiry_days = Some(1_096)).is_some());
    }
}
