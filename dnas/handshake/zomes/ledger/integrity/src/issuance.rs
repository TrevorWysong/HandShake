//! Money entering the ledger: an issuer's grant -- within the network's daily
//! limit, or in place of a part a lost key can't give back -- its recipient's
//! deposit of it, and an issuer's word on a card.

use super::*;

pub(crate) fn validate_grant(grant: &IssuerGrant, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if !handshake_governance::is_issuer(author)? {
        return invalid("only an issuer on the network's roster may issue funds");
    }
    // What it issues fresh, bounded per UTC day: a running total, carried
    // from the issuer's previous grant -- found walking back only to it, or
    // to the day's start, so checking costs the same however busy they are.
    let Some(prev) = prev_action else { return invalid("a grant can't open a chain") };
    let today = utc_day(at);
    let grant_type: ScopedEntryDefIndex = UnitEntryTypes::IssuerGrant.try_into()?;
    let mut before = 0u64;
    let mut failed = None;
    handshake_integrity_support::chain::walk_back(author, prev, |item| {
        let action = &item.action.hashed.content;
        if utc_day(action.timestamp()) != today {
            return Ok(std::ops::ControlFlow::Break(()));
        }
        if !handshake_integrity_support::chain::creates_one_of(action, &[grant_type]) {
            return Ok(std::ops::ControlFlow::Continue(()));
        }
        let Some(hash) = action.entry_hash() else { return Ok(std::ops::ControlFlow::Break(())) };
        match handshake_integrity_support::chain::entry_of(&item, hash)? {
            Entry::App(bytes) => match IssuerGrant::try_from(SerializedBytes::from(bytes)) {
                Ok(previous) => before = previous.issued_today,
                Err(_) => failed = Some("an issuer's previous grant can't be read"),
            },
            _ => failed = Some("an issuer's previous grant can't be read"),
        }
        Ok(std::ops::ControlFlow::Break(()))
    })?;
    if let Some(reason) = failed {
        return invalid(reason);
    }
    if grant.issued_today != before.saturating_add(grant.fresh()) {
        return invalid("a grant carries its issuer's total for the day, this one included");
    }
    if grant.issued_today > handshake_governance::issuer_daily_limit_cents() {
        return invalid("an issuer issues no more than the network's daily limit");
    }
    if grant.amount == 0 || grant.reference.trim().is_empty() {
        return invalid("a grant must be for something, with the issuer's reference");
    }
    if let Some(problem) = handshake_integrity_support::amount_problem("amount", grant.amount) {
        return invalid(&problem);
    }
    if let Some(problem) = first_problem([text_problem("reference", &grant.reference, handshake_integrity_support::limits::MAX_REFERENCE_CHARS)]) {
        return Ok(problem);
    }
    match &grant.in_place_of {
        Some(part) => validate_in_place_of(grant, part),
        None => valid(),
    }
}

/// An issuer's word on a card, from an issuer on the roster. A repeat says
/// nothing more, so it isn't walked for: an issuer's chain is long.
pub(crate) fn validate_card_attestation(_: &CardAttestation, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    require(handshake_governance::is_issuer(author)?, "only an issuer on the network's roster attests a card")
}

/// A grant in place of a part of a hold: to the hold's payer, for exactly
/// what the part would return them, of a recipient whose account a new key
/// has taken over -- so even an issuer can't pay a part's payer around a
/// recipient who still has their key.
pub(crate) fn validate_in_place_of(grant: &IssuerGrant, part: &HeldPart) -> ExternResult<ValidateCallbackResult> {
    let hold = match hold_of(&part.hold)? {
        Ok(hold) => hold,
        Err(reason) => return invalid(reason),
    };
    let Some(share) = hold.shares.iter().find(|s| s.portion == part.portion) else {
        return invalid("that hold has no such part");
    };
    if grant.to != hold.payer || share.recipient == hold.payer {
        return invalid("a grant in place of a part goes to the hold's payer, from someone else");
    }
    if grant.amount != share.amount {
        return invalid("a grant in place of a part is for exactly that part");
    }
    let succession = must_get_valid_record(part.succession.clone())?;
    let took_over = decode::<account_types::Succession>(&succession).is_some_and(|s| s.predecessor == share.recipient);
    require(took_over, "a grant in place of a part rests on a new key taking over its recipient's account")
}

pub(crate) fn validate_deposit(entry: &LedgerEntry, grant_ref: &ActionHash, author: &AgentPubKey, at: Timestamp, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let record = must_get_valid_record(grant_ref.clone())?;
    let Some(grant) = decode::<IssuerGrant>(&record) else { return invalid("a deposit must collect an issuer's grant") };
    if &grant.to != author || grant.amount != entry.amount {
        return invalid("a deposit must collect exactly a grant made to its author");
    }
    if grant.in_place_of.is_some() {
        return invalid("a grant in place of a part of a hold is collected as that part");
    }
    let granted_at = record.action().timestamp();
    if at < granted_at {
        return invalid("a grant is collected after it's made");
    }
    let again = ledger_since(author, prev_action, granted_at)?.into_iter().any(|e| matches!(&e.entry.kind, LedgerKind::Deposit { grant } if grant == grant_ref));
    if again {
        return invalid("that grant has already been collected");
    }
    valid()
}

/// A payer taking an issuer's grant in place of a part of their hold
/// (`IssuerGrant::in_place_of`): made to them, for that part, collected for
/// what it grants -- and deciding the part, once, like collecting it. Their
/// own chain is what keeps the two apart: whichever they write first, the
/// other is refused, so the payer is never paid the same part twice.
pub(crate) fn validate_returned(entry: &LedgerEntry, grant_ref: &ActionHash, hold_ref: &ActionHash, portion: Portion, author: &AgentPubKey, at: Timestamp, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let record = must_get_valid_record(grant_ref.clone())?;
    let Some(grant) = decode::<IssuerGrant>(&record) else { return invalid("a part's return collects an issuer's grant") };
    let in_place = grant.in_place_of.as_ref().is_some_and(|part| &part.hold == hold_ref && part.portion == portion);
    if &grant.to != author || grant.amount != entry.amount || !in_place {
        return invalid("a part's return collects exactly a grant made to its author in place of that part");
    }
    let hold = match hold_of(hold_ref)? {
        Ok(hold) => hold,
        Err(reason) => return invalid(reason),
    };
    if &hold.payer != author {
        return invalid("only a hold's payer takes a grant in place of its part");
    }
    if at < record.action().timestamp() || at < hold.held_at {
        return invalid("a grant is collected after it's made");
    }
    if already_decided(author, prev_action, hold_ref, portion, hold.held_at)? {
        return invalid("that part of the hold has already been decided");
    }
    valid()
}
