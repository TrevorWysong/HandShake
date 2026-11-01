//! Cashing out: a redemption of money that's there, its issuer's outcome
//! (once), a declined one reclaimed, and the issuer's public profile.

use super::*;

/// A cash-out: to an issuer on the roster other than its author, of at
/// least the network's minimum, with any payout instructions no larger than
/// a sealed note. (Its balance rule -- never below zero -- is checked with
/// the arithmetic.)
pub(crate) fn validate_redeem(entry: &LedgerEntry, issuer: &AgentPubKey, instructions: Option<&XSalsa20Poly1305EncryptedData>, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if !handshake_governance::is_issuer(issuer)? {
        return invalid("a cash-out names an issuer on the network's roster");
    }
    if issuer == author {
        return invalid("an issuer pays out others, not itself");
    }
    let min = handshake_governance::min_redemption_cents();
    if entry.amount < min {
        return invalid(&format!("a cash-out is at least {min}"));
    }
    if let Some(problem) = handshake_integrity_support::amount_problem("amount", entry.amount) {
        return invalid(&problem);
    }
    if let Some(sealed) = instructions {
        if let Some(problem) = handshake_integrity_support::sealed_problem("instructions", sealed, handshake_integrity_support::limits::MAX_SEALED_BYTES) {
            return invalid(&problem);
        }
    }
    valid()
}

/// The `Redeem` entry at `redemption`, with its author and when it was made.
pub(crate) fn redemption_of(redemption: &ActionHash) -> ExternResult<Option<(AgentPubKey, AgentPubKey, u64, Timestamp)>> {
    let record = must_get_valid_record(redemption.clone())?;
    Ok(match decode::<LedgerEntry>(&record) {
        Some(LedgerEntry { kind: LedgerKind::Redeem { issuer, .. }, amount, .. }) => Some((record.action().author().clone(), issuer, amount, record.action().timestamp())),
        _ => None,
    })
}

/// An issuer's outcome for a cash-out: by the issuer it names, after it,
/// once -- so a cash-out is never both paid and returned -- with a
/// reference for a payout and a reason for a refusal.
pub(crate) fn validate_outcome(outcome: &RedemptionOutcome, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some((_, issuer, _, redeemed_at)) = redemption_of(&outcome.redemption)? else { return invalid("an outcome answers a cash-out") };
    if &issuer != author {
        return invalid("only the issuer a cash-out names decides it");
    }
    if at < redeemed_at {
        return invalid("an outcome comes after its cash-out");
    }
    let text = match &outcome.outcome {
        PayoutOutcome::Paid { reference } => text_problem("reference", reference, handshake_integrity_support::limits::MAX_REFERENCE_CHARS).or_else(|| reference.trim().is_empty().then(|| "a payout names its reference".to_string())),
        PayoutOutcome::Declined { reason } => text_problem("reason", reason, handshake_integrity_support::limits::MAX_NOTE_CHARS).or_else(|| reason.trim().is_empty().then(|| "a refusal says why".to_string())),
    };
    if let Some(problem) = text {
        return invalid(&problem);
    }
    let Some(prev) = prev_action else { return invalid("an outcome can't open a chain") };
    let again = handshake_integrity_support::chain::wrote_since::<RedemptionOutcome>(author, prev, redeemed_at, UnitEntryTypes::RedemptionOutcome.try_into()?, |o| o.redemption == outcome.redemption)?;
    require(!again, "a cash-out is decided once")
}

/// A declined cash-out taken back: the author's own, for what it took,
/// citing its issuer's refusal, once.
pub(crate) fn validate_reclaim(entry: &LedgerEntry, redemption: &ActionHash, outcome_ref: &ActionHash, author: &AgentPubKey, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let Some((redeemer, issuer, amount, redeemed_at)) = redemption_of(redemption)? else { return invalid("a reclaim takes back a cash-out") };
    if &redeemer != author || entry.amount != amount {
        return invalid("a reclaim takes back exactly its author's own cash-out");
    }
    let outcome_record = must_get_valid_record(outcome_ref.clone())?;
    let declined = outcome_record.action().author() == &issuer
        && decode::<RedemptionOutcome>(&outcome_record).is_some_and(|o| &o.redemption == redemption && matches!(o.outcome, PayoutOutcome::Declined { .. }));
    if !declined {
        return invalid("a cash-out comes back only on its issuer's refusal");
    }
    let again = ledger_since(author, prev_action, redeemed_at)?.iter().any(|e| matches!(&e.entry.kind, LedgerKind::Reclaim { redemption: r, .. } if r == redemption));
    require(!again, "a cash-out comes back once")
}

/// An issuer's profile: by an issuer on the roster, with sensible terms.
pub(crate) fn validate_issuer_profile(profile: &IssuerProfile, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    use handshake_integrity_support::limits::{MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, MAX_NOTE_CHARS};
    if !handshake_governance::is_issuer(author)? {
        return invalid("only an issuer on the network's roster has an issuer profile");
    }
    if let Some(problem) = first_problem([
        text_problem("name", &profile.name, MAX_NAME_CHARS),
        text_problem("description", &profile.description, MAX_DESCRIPTION_CHARS),
        text_problem("contact", &profile.contact, MAX_NOTE_CHARS),
        handshake_integrity_support::amount_problem("payout_fee_cents", profile.payout_fee_cents),
        handshake_integrity_support::amount_problem("min_payout_cents", profile.min_payout_cents),
        text_problem("service_url", &profile.service_url, MAX_NOTE_CHARS),
    ]) {
        return Ok(problem);
    }
    if profile.name.trim().is_empty() {
        return invalid("an issuer has a name");
    }
    // The app calls it with people's keys and money: only over https.
    if !profile.service_url.is_empty() && !profile.service_url.starts_with("https://") && !profile.service_url.starts_with("http://localhost") && !profile.service_url.starts_with("http://127.0.0.1") {
        return invalid("an issuer's service is reached over https");
    }
    if profile.recovery_wait_days > 365 {
        return invalid("a recovery waits at most a year");
    }
    require(profile.payout_fee_basis_points <= 10_000, "a payout fee's share is at most the whole amount")
}
