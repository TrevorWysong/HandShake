//! Recurring order templates ("same order every Monday") -- see
//! `RecurringOrderTemplate`'s own doc comment in `dispatch_integrity` for
//! why this needs no DHT link at all. At its time a template asks its
//! customer to confirm it (`RecurringDue`, `tend_templates`): an order is
//! only ever placed by them, at checkout, paying with a card they have with
//! them -- so no store keeps a customer's card, and one that's missed
//! charges nobody.

use crate::pricing::OrderItem;
use chrono::{Datelike, Duration as Days, NaiveDate, TimeZone};
use chrono_tz::Tz;
use dispatch_integrity::*;
use hdk::prelude::*;
use handshake_coordinator_support::{decode_or, guest, open_chunked, resolve_latest, resolve_version_decoded, seal_chunked, update_version, written};
use handshake_types::GeoPoint;

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateRecurringTemplateInput {
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// What it orders each time: items, quantities and choices.
    pub items: Vec<OrderItem>,
    pub dropoff: GeoPoint,
    pub max_delivery_fee: Option<u64>,
    #[serde(default)]
    pub kitchen_notes: String,
    #[serde(default)]
    pub dropoff_notes: String,
    #[serde(default)]
    pub dropoff_line2: String,
    #[serde(default)]
    pub tip_cents: u64,
    #[serde(default)]
    pub dropoff_preference: DropoffPreference,
    /// Each order asks for a driver of its own.
    #[serde(default)]
    pub priority: bool,
    #[serde(default)]
    pub promo_code_ref: Option<ActionHash>,
    pub recurrence: RecurrenceRule,
    /// The IANA time zone `recurrence` means ("America/New_York") -- the
    /// customer's own, from their device.
    pub time_zone: String,
}

#[hdk_extern]
pub fn create_recurring_template(input: CreateRecurringTemplateInput) -> ExternResult<Record> {
    let requester = agent_info()?.agent_initial_pubkey;
    let (_, store) = crate::stores::current_catalog_version(&input.catalog_ref)?;
    if input.max_delivery_fee.is_some_and(|cap| cap > store.max_delivery_fee) {
        return Err(guest("That's more than this store allows for delivery. Choose a lower most you'll pay."));
    }
    let next_run_at = next_occurrence(&input.recurrence, &input.time_zone, sys_time()?.as_micros());
    crate::orders::check_note(&input.dropoff_notes)?;
    crate::orders::check_line2(&input.dropoff_line2)?;
    crate::orders::check_note(&input.kitchen_notes)?;
    let template = RecurringOrderTemplate {
        sealed_details: seal_chunked(&requester, &TemplateDetails { dropoff: input.dropoff, dropoff_line2: input.dropoff_line2, dropoff_notes: input.dropoff_notes, kitchen_notes: input.kitchen_notes, priority: input.priority })?,
        requester,
        merchant: input.merchant,
        catalog_ref: input.catalog_ref,
        items: input.items,
        max_delivery_fee: input.max_delivery_fee,
        tip_cents: input.tip_cents,
        dropoff_preference: input.dropoff_preference,
        promo_code_ref: input.promo_code_ref,
        recurrence: input.recurrence,
        time_zone: input.time_zone,
        next_run_at: Timestamp::from_micros(next_run_at),
        active: true,
        created_at: sys_time()?,
    };
    let owner = template.requester.clone();
    let action_hash = create_entry(&EntryTypes::RecurringOrderTemplate(template))?;
    create_link(owner, action_hash.clone(), LinkTypes::OwnerToTemplate, ())?;
    // The conductor reminds them when it's due -- see `upkeep`.
    crate::upkeep::tend_my_orders_soon()?;
    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetRecurringTemplateActiveInput {
    pub original_action: ActionHash,
    pub active: bool,
}

#[hdk_extern]
pub fn set_recurring_template_active(input: SetRecurringTemplateActiveInput) -> ExternResult<Record> {
    let (current, mut template): (_, RecurringOrderTemplate) = resolve_version_decoded(input.original_action, "RecurringOrderTemplate")?;
    let now = sys_time()?.as_micros();
    // Paused, its times went by unasked: back on, it's next due from now.
    if input.active && !template.active && template.next_run_at.as_micros() <= now {
        template.next_run_at = Timestamp::from_micros(next_occurrence(&template.recurrence, &template.time_zone, now));
    }
    template.active = input.active;
    let updated = update_version(&current, &EntryTypes::RecurringOrderTemplate(template), LinkTypes::Version)?;
    written(updated)
}

/// A template's stable identity (what `set_recurring_template_active`
/// takes) alongside its latest state.
#[derive(Serialize, Deserialize, Debug)]
pub struct RecurringTemplateView {
    pub original_action: ActionHash,
    pub record: Record,
    /// The template's sealed details, opened for its owner.
    pub details: Option<TemplateDetails>,
    pub due: RecurringDue,
}

/// Where a template stands. Its customer confirms each order at checkout;
/// one they don't get to in time is missed, never placed late.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecurringDue {
    NotYet,
    /// Its time has come, and it's still on time.
    ConfirmNow,
    /// Its time went by unanswered. Nothing was ordered or charged.
    Missed,
}

/// Every template the caller has created, at its latest state -- found by
/// the links from their own key, read on this device.
#[hdk_extern]
pub fn list_my_recurring_templates(_: ()) -> ExternResult<Vec<RecurringTemplateView>> {
    let me = agent_info()?.agent_initial_pubkey;
    let query = LinkQuery::try_new(me.clone(), LinkTypes::OwnerToTemplate)?.author(me.clone());
    let mut links = get_links(query, GetStrategy::Local)?;
    links.sort_by_key(|link| link.timestamp);
    let now = sys_time()?.as_micros();
    let mut views = Vec::new();
    for link in links {
        let Some(original_action) = link.target.into_action_hash() else { continue };
        let Ok(record) = resolve_latest(original_action.clone()) else { continue };
        let Some(template) = decode_or::<RecurringOrderTemplate>(&record) else { continue };
        let details = open_chunked(&me, &template.sealed_details)?;
        let due = if template.active { standing_due(template.next_run_at.as_micros(), now) } else { RecurringDue::NotYet };
        views.push(RecurringTemplateView { original_action, record, details, due });
    }
    Ok(views)
}

/// Where a template stands at `now`, from when it's next due.
fn standing_due(due: i64, now: i64) -> RecurringDue {
    if now < due {
        RecurringDue::NotYet
    } else if now < due.saturating_add(handshake_governance::SCHEDULE_SEND_GRACE.as_micros() as i64) {
        RecurringDue::ConfirmNow
    } else {
        RecurringDue::Missed
    }
}

/// Reminds this person of each active template whose time has come, and
/// returns when the next one is due, in microseconds since the epoch. It
/// never orders: that takes them, at checkout, paying then (`RecurringDue`).
pub(crate) fn tend_templates(now: i64) -> ExternResult<Option<i64>> {
    let mut next: Option<i64> = None;
    for view in list_my_recurring_templates(())? {
        let Some(template) = decode_or::<RecurringOrderTemplate>(&view.record).filter(|template| template.active) else { continue };
        let due = template.next_run_at.as_micros();
        match standing_due(due, now) {
            RecurringDue::NotYet => next = Some(next.map_or(due, |earliest| earliest.min(due))),
            // Heard only by this person's own app, if it's running.
            RecurringDue::ConfirmNow => {
                let _ = emit_signal(crate::signals::LocalSignal::RecurringOrderDue(view.original_action));
            }
            RecurringDue::Missed => {}
        }
    }
    Ok(next)
}

/// Moves a template that's come due on to its next occurrence: its customer
/// has taken it to checkout, or passed on it. One not yet due stays as it is,
/// so a second tap can't lose a later occurrence.
#[hdk_extern]
pub fn advance_recurring_template(original_action: ActionHash) -> ExternResult<Record> {
    let (current, mut template): (_, RecurringOrderTemplate) = resolve_version_decoded(original_action, "RecurringOrderTemplate")?;
    let now = sys_time()?.as_micros();
    if standing_due(template.next_run_at.as_micros(), now) == RecurringDue::NotYet {
        return Ok(current.record);
    }
    template.next_run_at = Timestamp::from_micros(next_occurrence(&template.recurrence, &template.time_zone, now));
    written(update_version(&current, &EntryTypes::RecurringOrderTemplate(template), LinkTypes::Version)?)
}

/// The first time `rule` fires strictly after `after` (microseconds since
/// the epoch), reading its hour and minute as wall-clock time in
/// `time_zone` -- so "9:00 every day" stays 9:00 local across
/// daylight-saving changes. An unknown zone reads as UTC. A time that a
/// spring-forward skips fires at the first moment after the gap; one that
/// a fall-back repeats fires the first time round.
pub(crate) fn next_occurrence(rule: &RecurrenceRule, time_zone: &str, after: i64) -> i64 {
    let after_local = crate::stores::local_time(time_zone, after);
    let tz = after_local.timezone();
    let (weekday, hour, minute) = match *rule {
        RecurrenceRule::Daily { hour, minute } => (None, hour, minute),
        RecurrenceRule::Weekly { weekday, hour, minute } => (Some(weekday), hour, minute),
    };
    let mut date = after_local.date_naive();
    // At most a week and a day ahead; the loop bound is only a backstop.
    for _ in 0..9 {
        let right_day = weekday.is_none_or(|w| date.weekday().num_days_from_sunday() == w as u32);
        if right_day {
            if let Some(at) = local_to_micros(tz, date, hour, minute) {
                if at > after {
                    return at;
                }
            }
        }
        date += Days::days(1);
    }
    after + 7 * 24 * 3_600 * 1_000_000
}

/// `date` at `hour:minute` in `tz`, in microseconds since the epoch.
fn local_to_micros(tz: Tz, date: NaiveDate, hour: u8, minute: u8) -> Option<i64> {
    let naive = date.and_hms_opt(hour as u32, minute as u32, 0)?;
    match tz.from_local_datetime(&naive).earliest() {
        Some(at) => Some(at.timestamp_micros()),
        // In a spring-forward gap: the first moment after it.
        None => tz.from_local_datetime(&(naive + Days::hours(1))).earliest().map(|at| (at - Days::minutes(minute as i64)).timestamp_micros()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_template_asks_on_time_and_is_missed_after_never_placed_late() {
        let due = 1_000_000_000_000;
        let grace = handshake_governance::SCHEDULE_SEND_GRACE.as_micros() as i64;
        assert_eq!(standing_due(due, due - 1), RecurringDue::NotYet);
        assert_eq!(standing_due(due, due), RecurringDue::ConfirmNow);
        assert_eq!(standing_due(due, due + grace - 1), RecurringDue::ConfirmNow);
        assert_eq!(standing_due(due, due + grace), RecurringDue::Missed);
    }

    /// 2026-03-07 12:00 UTC, a Saturday -- the day before the US springs
    /// forward (2026-03-08).
    const SAT_NOON_UTC: i64 = 1_772_884_800_000_000;
    const HOUR: i64 = 3_600 * 1_000_000;

    fn utc(micros: i64) -> String {
        Tz::UTC.timestamp_micros(micros).unwrap().format("%Y-%m-%d %H:%M %a").to_string()
    }

    #[test]
    fn daily_fires_at_the_next_wall_clock_time() {
        let at = next_occurrence(&RecurrenceRule::Daily { hour: 13, minute: 30 }, "UTC", SAT_NOON_UTC);
        assert_eq!(utc(at), "2026-03-07 13:30 Sat");
        let at = next_occurrence(&RecurrenceRule::Daily { hour: 9, minute: 0 }, "UTC", SAT_NOON_UTC);
        assert_eq!(utc(at), "2026-03-08 09:00 Sun", "a time already past today is tomorrow");
    }

    #[test]
    fn daily_keeps_local_time_across_daylight_saving() {
        let rule = RecurrenceRule::Daily { hour: 9, minute: 0 };
        // 9:00 in New York is 14:00 UTC before the change and 13:00 after.
        let first = next_occurrence(&rule, "America/New_York", SAT_NOON_UTC);
        assert_eq!(utc(first), "2026-03-07 14:00 Sat");
        let second = next_occurrence(&rule, "America/New_York", first);
        assert_eq!(utc(second), "2026-03-08 13:00 Sun");
        assert_eq!(second - first, 23 * HOUR, "the spring-forward day is an hour short");
    }

    #[test]
    fn a_time_skipped_by_spring_forward_fires_after_the_gap() {
        // 2:30 doesn't exist in New York on 2026-03-08.
        let at = next_occurrence(&RecurrenceRule::Daily { hour: 2, minute: 30 }, "America/New_York", SAT_NOON_UTC + 12 * HOUR);
        assert_eq!(utc(at), "2026-03-08 07:00 Sun", "3:00 local, the first moment after the gap");
    }

    #[test]
    fn weekly_fires_on_its_weekday_counting_from_sunday() {
        let monday = RecurrenceRule::Weekly { weekday: 1, hour: 8, minute: 15 };
        assert_eq!(utc(next_occurrence(&monday, "UTC", SAT_NOON_UTC)), "2026-03-09 08:15 Mon");
        let saturday_later = RecurrenceRule::Weekly { weekday: 6, hour: 18, minute: 0 };
        assert_eq!(utc(next_occurrence(&saturday_later, "UTC", SAT_NOON_UTC)), "2026-03-07 18:00 Sat", "later the same day");
        let saturday_earlier = RecurrenceRule::Weekly { weekday: 6, hour: 6, minute: 0 };
        assert_eq!(utc(next_occurrence(&saturday_earlier, "UTC", SAT_NOON_UTC)), "2026-03-14 06:00 Sat", "a week on");
    }

    #[test]
    fn an_unknown_zone_reads_as_utc() {
        let rule = RecurrenceRule::Daily { hour: 13, minute: 0 };
        assert_eq!(next_occurrence(&rule, "Not/AZone", SAT_NOON_UTC), next_occurrence(&rule, "UTC", SAT_NOON_UTC));
    }
}
