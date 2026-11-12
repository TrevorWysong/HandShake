//! A member's points at a store as a running total -- so a card, or a
//! store's check before it honours a reward, costs what's still open, not
//! everything that ever happened (docs/REWARDS.md, "Accounts").
//!
//! Points are worked out by playing a member's history through the rules
//! (`points::replay`): every order's earning and spending, every grant, in
//! time order. A long history is played once; after that it's kept folded
//! into a state, and only what can still change is played on top of it.
//!
//! What can be folded, and when, is what makes this exact -- the same as
//! playing everything, every time (the tests below hold it to that):
//!
//! - **An order is folded once nothing about it can change** (`done`): its
//!   store settled it and its refund period is over (an appeal ruled), or
//!   it ended without the store ever accepting it.
//! - **Everything folded came before everything not** (`through`). An
//!   order that's still open can bring events no sooner than it was
//!   placed, so nothing at or after the oldest open order's placing is
//!   folded -- nor anything at or after an event of a done order that
//!   can't be folded whole. So the rules always see one history, in order.
//! - **Anything that turns up from before `through`** -- a grant gossiped
//!   late, say -- can't be put in its place, and the history is played
//!   afresh (`Rebuild`). So is one whose program changed: every point is
//!   played under the store's current rules.

use crate::points::{replay_from, roll, Event, PointsState};
use crate::RewardsProgram;
use hdi::prelude::*;

/// A member's points at a store, folded so far.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Ledger {
    /// The program version whose rules played it.
    pub program: ActionHash,
    /// Every event folded into `state` came before this; nothing still to
    /// come can.
    pub through: Timestamp,
    /// Where the member stood at `through` (`None` before anything).
    pub state: Option<PointsState>,
    /// Orders not folded yet: what they spend or earn can still change, or
    /// they came at or after `through`.
    pub open_orders: Vec<OpenOrder>,
    /// Grants not folded yet: given at or after `through`.
    pub open_grants: Vec<OpenGrant>,
    /// The grants folded in: the member reads a store's grants by link, and
    /// passes over these -- so one from before `through` that turns up late
    /// is noticed, not lost.
    pub folded_grants: Vec<ActionHash>,
    /// What the newest folded events moved, oldest first: the card's history.
    pub recent: Vec<LedgerLine>,
}

/// An order that joined a program, as the side keeping the ledger knows it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct OpenOrder {
    /// Its original action.
    pub order: ActionHash,
    pub placed_at: Timestamp,
    /// The store's acceptance of it, once known.
    pub accepted: Option<ActionHash>,
    /// The reward it names (id), if it names one.
    pub reward: Option<u16>,
    /// What its store's settlement fixed, once it's settled and nobody has
    /// appealed it: all that's left to happen is its refund period ending,
    /// so a read checks only for an appeal (`None`: not settled yet).
    #[serde(default)]
    pub settled: Option<Settled>,
}

/// What an order's settlement fixed, for its points.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Settled {
    /// The reward it spent, still spent once it's settled: when the store
    /// accepted it, what it cost, and the tier it needed.
    pub spend: Option<(Timestamp, u64, u8)>,
    pub settled_at: Timestamp,
    /// What it earns, before the member's tier.
    pub base: u64,
    /// When its refund period ends.
    pub available_at: Timestamp,
    /// Its appeal window closed, with no appeal, long enough ago for any
    /// appeal to have reached everyone (`appeal_arrival`): nothing can
    /// change it now, so it's never read again.
    #[serde(default)]
    pub closed: bool,
}

impl Settled {
    /// Whether, with no appeal found at `now`, none can come: its window
    /// closed longer ago than an appeal takes to arrive.
    pub fn closes(&self, now: Timestamp) -> bool {
        let arrival = i64::try_from(handshake_governance::appeal_arrival().as_micros()).unwrap_or(i64::MAX);
        now.as_micros() > self.available_at.as_micros().max(self.settled_at.as_micros()).saturating_add(arrival)
    }

    /// Whether its refund period is over at `now`.
    pub fn ended(&self, now: Timestamp) -> bool {
        if self.available_at > self.settled_at {
            now > self.available_at
        } else {
            now >= self.settled_at
        }
    }
}

/// A store's grant to the member.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct OpenGrant {
    pub grant: ActionHash,
    pub at: Timestamp,
    pub points: u32,
    pub kind: GrantKind,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum GrantKind {
    Gift { note: Option<String> },
    Birthday,
    Carried,
}

/// What one event moved, for a member's history.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct LedgerLine {
    /// The order or grant it came from.
    pub entry: ActionHash,
    pub at: Timestamp,
    pub kind: LineKind,
    /// In (positive) or out (negative), as it stood then.
    pub points: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum LineKind {
    Earned,
    Spent,
    Gift { note: Option<String> },
    Birthday,
    Carried,
}

/// A member's points at a store as a running total (`Ledger`), kept
/// privately by the side that reads them -- the store's account of each of
/// its members, or a member's of each store they belong to -- so neither
/// plays a whole history again to know where they stand. Each version is
/// written whole, never updated (an update of a private entry would need
/// the network to see the entry it updates), and found by its
/// `KeptVersion`.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemberAccount {
    pub catalog_ref: ActionHash,
    pub member: AgentPubKey,
    /// The store's account of the member (`true`), or the member's own.
    pub kept_by_store: bool,
    /// `None` until it's been played: a member's account notes their orders
    /// from the first, and plays them once it's read.
    pub ledger: Option<Ledger>,
    /// The member's latest order there: what a store's grant cites, and
    /// what a member's birthday share does.
    pub latest_order: Option<ActionHash>,
    /// The store's side: how many of the member's reveals it had when it
    /// last carried what they held at the store this one was brought over
    /// from, on the network before -- `None` if it never has. A reveal
    /// since means more to carry.
    #[serde(default)]
    pub carried_at: Option<u32>,
}

/// The stores a member keeps an account at (`MemberAccount`), for their
/// wallet: private to their device, kept as an account is.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemberStores {
    pub member: AgentPubKey,
    /// Each store's original action, newest first.
    pub stores: Vec<ActionHash>,
}

/// Which private record a `KeptVersion` marks.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum KeptRecord {
    Account { catalog_ref: ActionHash, member: AgentPubKey, kept_by_store: bool },
    Stores { member: AgentPubKey },
    Birthdays { catalog_ref: ActionHash },
}

/// The birth months a store has read from its members' sealed shares
/// (`BirthdayShare`), kept privately so a sweep needn't open them all again
/// -- a cache: a device that loses it reads them again, in turn.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemberBirthdays {
    pub catalog_ref: ActionHash,
    /// Each member's month, 1 to 12, as they first told the store.
    pub months: Vec<(AgentPubKey, u8)>,
}

/// Marks the `n`th version (from 1) of a record its author keeps privately,
/// written straight after that version, so the version is the action just
/// before it. Its content is only which record and which version, so its
/// hash is the same every time: the latest version is found by looking a
/// few hashes up -- doubling `n`, then halving between -- however many
/// versions there are, never by walking the chain.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct KeptVersion {
    pub record: KeptRecord,
    pub n: u32,
}

/// One order as it stands now: what it's brought about so far, and whether
/// that can still change.
#[derive(Debug, Clone)]
pub struct OrderFacts {
    pub order: OpenOrder,
    pub events: Vec<Event>,
    pub done: bool,
}

/// A ledger carried forward to now.
#[derive(Debug, Clone)]
pub struct Folded {
    pub ledger: Ledger,
    /// Whether anything was folded in or let go, or an open order learned
    /// something (its acceptance, its settlement, its window closing):
    /// worth keeping, so the next read needn't learn it again.
    pub moved: bool,
    /// Where the member stands now: everything played, rolled to now.
    pub state: Option<PointsState>,
    /// What each event moved, newest first: what's still open, then what's
    /// folded, as far as the ledger keeps.
    pub history: Vec<LedgerLine>,
}

/// Why a ledger can't be carried forward: the history has to be played
/// afresh, from everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rebuild {
    /// The store's program changed: every point is played under its rules.
    ProgramChanged,
    /// Something turned up from before what's folded.
    Late,
}

/// The moment before anything: where a ledger played from nothing starts.
const BEGINNING: Timestamp = Timestamp(i64::MIN);

/// `prior` carried forward to `now`: `orders` are its open orders as they
/// stand now, and any new since -- each once; `grants`, its open grants and
/// any new. With no `prior`, they're everything, played from nothing.
/// `keep` is how many lines of history the ledger keeps.
pub fn fold(program: &RewardsProgram, version: &ActionHash, prior: Option<&Ledger>, orders: Vec<OrderFacts>, grants: Vec<OpenGrant>, now: Timestamp, keep: usize) -> Result<Folded, Rebuild> {
    if prior.is_some_and(|l| &l.program != version) {
        return Err(Rebuild::ProgramChanged);
    }
    let through = prior.map_or(BEGINNING, |l| l.through);
    if orders.iter().flat_map(|o| &o.events).any(|e| e.at() < through) || grants.iter().any(|g| g.at < through) {
        return Err(Rebuild::Late);
    }

    // How far it can fold: short of the oldest open order's placing, and
    // short of any event of a done order that can't be folded whole.
    let mut until = orders.iter().filter(|o| !o.done).map(|o| o.order.placed_at).fold(now, Timestamp::min);
    loop {
        let lower = orders
            .iter()
            .filter(|o| o.done && o.events.iter().any(|e| e.at() >= until))
            .filter_map(|o| o.events.iter().map(Event::at).min())
            .filter(|at| *at < until)
            .min();
        match lower {
            Some(at) => until = at,
            None => break,
        }
    }
    let until = until.max(through);
    let foldable = |o: &OrderFacts| o.done && o.events.iter().all(|e| e.at() < until);

    let kinds: Vec<(ActionHash, GrantKind)> = grants.iter().map(|g| (g.grant.clone(), g.kind.clone())).collect();
    let events_of = |o: &OrderFacts| o.events.iter().map(|e| (*e, o.order.order.clone())).collect::<Vec<_>>();
    let grant_event = |g: &OpenGrant| (Event::Credit { at: g.at, points: u64::from(g.points) }, g.grant.clone());
    let (folding, open): (Vec<OrderFacts>, Vec<OrderFacts>) = orders.into_iter().partition(foldable);
    let (folding_grants, open_grants): (Vec<OpenGrant>, Vec<OpenGrant>) = grants.into_iter().partition(|g| g.at < until);

    let line = |(entry, event, points): (ActionHash, Event, i64)| {
        let kind = match event {
            Event::Earn { .. } => LineKind::Earned,
            Event::Spend { .. } => LineKind::Spent,
            Event::Credit { .. } => match kinds.iter().find(|(g, _)| g == &entry).map(|(_, k)| k) {
                Some(GrantKind::Birthday) => LineKind::Birthday,
                Some(GrantKind::Carried) => LineKind::Carried,
                Some(GrantKind::Gift { note }) => LineKind::Gift { note: note.clone() },
                None => LineKind::Gift { note: None },
            },
        };
        LedgerLine { entry, at: event.at(), kind, points }
    };

    let learned = prior.is_some_and(|l| l.open_orders.len() != open.len() || open.iter().any(|o| !l.open_orders.contains(&o.order)));
    let moved = prior.is_none() || !folding.is_empty() || !folding_grants.is_empty() || learned;
    let folded_events: Vec<(Event, ActionHash)> = folding.iter().flat_map(events_of).chain(folding_grants.iter().map(grant_event)).collect();
    let (state, folded_log) = replay_from(program, prior.and_then(|l| l.state.clone()), folded_events);
    let mut recent = prior.map(|l| l.recent.clone()).unwrap_or_default();
    recent.extend(folded_log.into_iter().map(line));
    let excess = recent.len().saturating_sub(keep);
    recent.drain(..excess);

    let open_events: Vec<(Event, ActionHash)> = open.iter().flat_map(events_of).chain(open_grants.iter().map(grant_event)).collect();
    let (now_state, open_log) = replay_from(program, state.clone(), open_events);
    let mut history: Vec<LedgerLine> = recent.iter().cloned().chain(open_log.into_iter().map(line)).collect();
    history.reverse();
    history.truncate(keep);

    let ledger = Ledger {
        program: version.clone(),
        through: until,
        state,
        open_orders: open.into_iter().map(|o| o.order).collect(),
        open_grants,
        folded_grants: prior.map(|l| l.folded_grants.clone()).unwrap_or_default().into_iter().chain(folding_grants.iter().map(|g| g.grant.clone())).collect(),
        recent,
    };
    Ok(Folded { ledger, moved, state: now_state.map(|s| roll(program, &s, now)), history })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::points::replay;
    use crate::tests::program as base_program;
    use crate::Tier;

    const DAY: i64 = 86_400_000_000;
    const START: i64 = 1_767_225_600_000_000; // 2026-01-01

    fn hash(n: u64) -> ActionHash {
        let mut raw = vec![0u8; 36];
        raw[..8].copy_from_slice(&n.to_be_bytes());
        ActionHash::from_raw_36(raw)
    }

    /// A program that exercises everything the order of events matters
    /// to: tiers that roll by year, points that expire, a welcome and caps.
    fn program() -> RewardsProgram {
        let mut p = base_program();
        p.earn.welcome_bonus = 25;
        p.earn.max_per_order = Some(400);
        p.tiers = vec![Tier { name: "Silver".into(), threshold: 600, percent: 125, perk: String::new() }, Tier { name: "Gold".into(), threshold: 2_000, percent: 150, perk: String::new() }];
        p.expiry_days = Some(45);
        p.max_balance = Some(5_000);
        p
    }

    /// A small, seeded generator: the same history every run.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// One order's life: when each thing happens to it.
    struct Life {
        order: OpenOrder,
        /// When the store accepted it (`None`: it never did).
        accepted_at: Option<i64>,
        /// The reward it spends, if accepted, and when it's given back.
        spend: Option<u64>,
        given_back_at: Option<i64>,
        settled_at: Option<i64>,
        base: u64,
        /// When nothing about it can change any more.
        done_at: i64,
    }

    impl Life {
        /// The order as it stands at `now`.
        fn facts(&self, now: i64) -> OrderFacts {
            let mut events = Vec::new();
            if let (Some(accepted), Some(cost)) = (self.accepted_at, self.spend) {
                if accepted <= now && self.given_back_at.is_none_or(|back| back > now) {
                    events.push(Event::Spend { at: Timestamp(accepted), cost, min_tier: 0 });
                }
            }
            if let Some(settled) = self.settled_at {
                // Earned once it's done: through its refund period.
                if self.done_at <= now && self.base > 0 {
                    events.push(Event::Earn { at: Timestamp(settled), base: self.base });
                }
            }
            OrderFacts { order: self.order.clone(), events, done: self.done_at <= now }
        }
    }

    /// `orders` orders over time, with grants among them.
    fn history(orders: usize, seed: u64) -> (Vec<Life>, Vec<OpenGrant>) {
        let mut rng = Rng(seed);
        let mut at = START;
        let mut lives = Vec::new();
        let mut grants = Vec::new();
        for n in 0..orders {
            // Sometimes several a day, sometimes weeks apart -- long enough
            // for points to expire.
            at += match rng.below(10) {
                0 => 50 * DAY,
                1..=3 => rng.below(5 * DAY as u64) as i64,
                _ => rng.below(DAY as u64 / 4) as i64 + 1,
            };
            let placed = at;
            let accepted = (rng.below(8) != 0).then(|| placed + 1 + rng.below(300_000_000) as i64);
            let spend = accepted.and_then(|_| (rng.below(4) == 0).then(|| [100u64, 250, 700][rng.below(3) as usize]));
            let settled = accepted.map(|a| a + rng.below(3 * 3_600_000_000) as i64 + 1);
            // Its refund period, and now and then an appeal that runs long.
            let done = match (accepted, settled) {
                (Some(_), Some(s)) => s + 14 * DAY + if rng.below(15) == 0 { rng.below(60 * DAY as u64) as i64 } else { 0 },
                _ => placed + rng.below(600_000_000) as i64 + 1,
            };
            let given_back = settled.filter(|_| spend.is_some() && rng.below(10) == 0);
            lives.push(Life {
                order: OpenOrder { order: hash(n as u64 + 1), placed_at: Timestamp(placed), accepted: None, reward: spend.map(|_| 1), settled: None },
                accepted_at: accepted,
                spend,
                given_back_at: given_back,
                settled_at: settled,
                base: if rng.below(12) == 0 { 0 } else { 50 + rng.below(3_000) },
                done_at: done,
            });
            if rng.below(20) == 0 {
                let kind = if rng.below(3) == 0 { GrantKind::Birthday } else { GrantKind::Gift { note: Some(format!("thanks {n}")) } };
                grants.push(OpenGrant { grant: hash(1_000_000 + n as u64), at: Timestamp(placed + 7), points: 10 + rng.below(200) as u32, kind });
            }
        }
        (lives, grants)
    }

    /// Everything played afresh, as of `now` -- what the ledger must agree with.
    fn played_whole(program: &RewardsProgram, lives: &[Life], grants: &[OpenGrant], now: i64) -> Option<PointsState> {
        let mut events: Vec<(Event, ActionHash)> = Vec::new();
        for life in lives.iter().filter(|l| l.order.placed_at.0 <= now) {
            events.extend(life.facts(now).events.into_iter().map(|e| (e, life.order.order.clone())));
        }
        events.extend(grants.iter().filter(|g| g.at.0 <= now).map(|g| (Event::Credit { at: g.at, points: u64::from(g.points) }, g.grant.clone())));
        replay(program, events).0.map(|s| roll(program, &s, Timestamp(now)))
    }

    /// The member's card read every day of `orders` orders' history,
    /// carried forward each time, checked against playing everything --
    /// every `check` reads, and at the end.
    fn carried_forward_agrees(orders: usize, check: usize) -> (usize, usize) {
        let program = program();
        let version = hash(u64::MAX);
        let (lives, grants) = history(orders, 0x9E37_79B9_7F4A_7C15 ^ orders as u64);
        let end = lives.iter().map(|l| l.done_at).max().unwrap() + DAY;
        let mut ledger: Option<Ledger> = None;
        let (mut next_order, mut next_grant, mut reads, mut most_open) = (0, 0, 0, 0);
        let mut now = START;
        while now <= end {
            // What's open, as it stands now, and whatever's new since.
            let mut facts: Vec<OrderFacts> = ledger.iter().flat_map(|l| &l.open_orders).map(|o| lives[life_index(&o.order)].facts(now)).collect();
            while next_order < lives.len() && lives[next_order].order.placed_at.0 <= now {
                facts.push(lives[next_order].facts(now));
                next_order += 1;
            }
            let mut open: Vec<OpenGrant> = ledger.iter().flat_map(|l| l.open_grants.clone()).collect();
            while next_grant < grants.len() && grants[next_grant].at.0 <= now {
                open.push(grants[next_grant].clone());
                next_grant += 1;
            }
            let folded = fold(&program, &version, ledger.as_ref(), facts, open, Timestamp(now), 30).expect("nothing arrives late here");
            reads += 1;
            if reads % check == 0 || now + DAY > end {
                assert_eq!(folded.state, played_whole(&program, &lives, &grants, now), "after {next_order} orders, at read {reads}");
            }
            most_open = most_open.max(folded.ledger.open_orders.len());
            ledger = Some(folded.ledger);
            now += DAY;
        }
        let ledger = ledger.unwrap();
        assert!(ledger.open_orders.is_empty() && ledger.open_grants.is_empty(), "once everything's done, everything's folded");
        assert_eq!(ledger.folded_grants.len(), grants.len());
        (reads, most_open)
    }

    // The order a life is looked up by is its number, in the hash's leading
    // bytes (`hash`); lives are numbered from 1.
    fn life_index(order: &ActionHash) -> usize {
        u64::from_be_bytes(order.get_raw_36()[..8].try_into().unwrap()) as usize - 1
    }

    #[test]
    fn a_ledger_agrees_with_playing_everything_past_501_orders() {
        carried_forward_agrees(501, 1);
    }

    #[test]
    fn and_past_5_000() {
        carried_forward_agrees(5_000, 7);
    }

    #[test]
    #[ignore = "a minute or so in a debug build: cargo test --release -- --ignored"]
    fn and_past_50_000() {
        carried_forward_agrees(50_000, 90);
    }

    #[test]
    fn what_stays_open_is_what_can_still_change_not_the_whole_history() {
        let (reads, most_open) = carried_forward_agrees(5_000, 365);
        assert!(reads > 300, "a long history, read often");
        assert!(most_open < 400, "a read plays what's open -- {most_open} at most -- never thousands");
    }

    #[test]
    fn a_grant_from_before_what_is_folded_plays_it_all_afresh() {
        let program = program();
        let version = hash(1);
        let early = OrderFacts { order: OpenOrder { order: hash(2), placed_at: Timestamp(START), accepted: None, reward: None, settled: None }, events: vec![Event::Earn { at: Timestamp(START + 1), base: 100 }], done: true };
        let folded = fold(&program, &version, None, vec![early], Vec::new(), Timestamp(START + 10 * DAY), 30).unwrap();
        assert!(folded.ledger.through > Timestamp(START + 1), "the order is folded");
        let late = OpenGrant { grant: hash(3), at: Timestamp(START + 2), points: 5, kind: GrantKind::Birthday };
        assert_eq!(fold(&program, &version, Some(&folded.ledger), Vec::new(), vec![late], Timestamp(START + 11 * DAY), 30).unwrap_err(), Rebuild::Late);
        assert_eq!(fold(&program, &hash(9), Some(&folded.ledger), Vec::new(), Vec::new(), Timestamp(START + 11 * DAY), 30).unwrap_err(), Rebuild::ProgramChanged, "and so does a changed program");
    }

    #[test]
    fn an_open_order_holds_back_everything_after_it() {
        let program = program();
        let version = hash(1);
        let at = |d: i64| Timestamp(START + d * DAY);
        let order = |n: u64, placed: i64, events: Vec<Event>, done: bool| OrderFacts { order: OpenOrder { order: hash(n), placed_at: at(placed), accepted: None, reward: None, settled: None }, events, done };
        // An order still in review from day 1; one done from day 2.
        let reviewing = order(2, 1, Vec::new(), false);
        let done = order(3, 2, vec![Event::Earn { at: at(2), base: 300 }], true);
        let folded = fold(&program, &version, None, vec![reviewing, done], Vec::new(), at(30), 30).unwrap();
        assert_eq!(folded.ledger.through, at(1), "nothing at or after the open order is folded");
        assert_eq!(folded.ledger.open_orders.len(), 2, "so the done one waits with it");
        assert_eq!(folded.state.map(|s| s.balance), Some(300 + 25), "and still counts now, as it should");
    }

    #[test]
    fn history_keeps_its_newest_lines() {
        let program = program();
        let version = hash(1);
        let orders = (0..50).map(|n| OrderFacts { order: OpenOrder { order: hash(n + 2), placed_at: Timestamp(START + n as i64 * DAY), accepted: None, reward: None, settled: None }, events: vec![Event::Earn { at: Timestamp(START + n as i64 * DAY + 1), base: 100 }], done: true }).collect();
        let folded = fold(&program, &version, None, orders, Vec::new(), Timestamp(START + 60 * DAY), 30).unwrap();
        assert_eq!(folded.ledger.recent.len(), 30);
        assert_eq!(folded.history.len(), 30);
        assert_eq!(folded.history[0].entry, hash(51), "newest first");
    }
}
