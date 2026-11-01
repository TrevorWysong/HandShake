//! Integrity zome for the ledger: escrowed payments for orders, validated
//! on each agent's own chain.
//!
//! What validation guarantees:
//!
//! - **A balance is the arithmetic of its owner's own chain.** Every entry
//!   says what it leaves its author with and points at their previous
//!   entry; validation walks the author's chain to check nothing between
//!   them was skipped and the sum holds. Nobody can state a balance, hide a
//!   debit, or mint money -- funds enter only from an issuer on the DNA's
//!   roster (`IssuerGrant`).
//! - **Money for an order is held before it's needed.** A hold is priced
//!   from the order's fixed terms (`dispatch_types::settlement`), paid by
//!   whoever owes it, and can't take a balance below the DNA's credit limit
//!   -- so with a limit of 0, an identity with nothing in it can't order.
//!   Each step of an order cites its hold (`dispatch_integrity`): a store
//!   can't accept an order whose food isn't paid for.
//! - **Each part of a hold is paid out once, on one decision.** Once an
//!   order is out of the kitchen, everything moves on the store's single
//!   decision about it (`dispatch_types::issues`): its outcome (delivered,
//!   or not) and its settlement of the food. The store can write each only
//!   once, so no two payments can rest on contradictory decisions. Before
//!   that, a cancellation settles what the canceller owes, and a recipient
//!   can always waive a part back. Each party decides each part once --
//!   entries on their own chain, which validation walks.
//! - **A part its recipient's lost key can't give back is paid once.** An
//!   issuer may grant the payer exactly that part in its place, once the
//!   recipient's account has been taken over by a new key
//!   (`IssuerGrant::in_place_of`). The payer takes it *as* the part
//!   (`Returned`), so their own chain decides it once: never the grant and
//!   the part both (docs/RECOVERY.md).
//!
//! - **A driver carries a bounded number of orders.** Every entry carries
//!   the orders its author has in hand (`InHand`), checked against their
//!   previous entry like the balance: picking one up (its collateral hold)
//!   adds one -- refused past the network's `max_concurrent_deliveries`, or
//!   alongside a priority order, which goes alone -- and settling it (the
//!   collateral back, or forfeited on the store's decision) takes one away.
//!
//! - **Money leaves only as money that's there.** A cash-out (`Redeem`)
//!   names an issuer on the roster, is at least the network's minimum, and
//!   can't take its author below zero, whatever the credit limit: credit is
//!   never cashed out. Its issuer writes its outcome once -- paid, or
//!   declined -- and only a declined one comes back to its author, once.
//!
//! What it can't: move money nobody is entitled to collect yet. An order
//! nobody has decided stays held. Nor make an issuer pay: what an issuer
//! does outside the network rests on its public record of outcomes, and on
//! the roster that names it.

use dispatch_types::lineage::{self, Version};
use dispatch_types::{hold_amount, hold_terms, Bid, Cancellation, DeliveryOrder, DeliveryStatus, ItemSettlement, OrderOutcome, OrderTerms, Outcome, PickupOrder, PickupStatus, Share};
use hdi::prelude::*;
pub use ledger_types::*;
use catalog_types::{listing_tag, MerchantCatalog, CATALOG_INTEGRITY_ZOME};
use handshake_integrity_support::{classify, decode, first_problem, invalid, linked_record, original_creation, require, text_problem, valid, Checked};

mod cash_out;
mod collect;
mod holds;
mod issuance;
mod listing;
use cash_out::*;
use collect::*;
use holds::*;
use issuance::*;
use listing::*;

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    LedgerEntry(LedgerEntry),
    IssuerGrant(IssuerGrant),
    RedemptionOutcome(RedemptionOutcome),
    IssuerProfile(IssuerProfile),
    CardAttestation(CardAttestation),
    CardRevocation(CardRevocation),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// An entry's update, base = its original, tagged with how deep it is --
    /// how its current version is found in one read
    /// (`handshake_integrity_support::versions`). First in every zome.
    Version,
    /// An order's holds, so its parties can find what they're owed.
    OrderToHold,
    /// A hold's waivers, so its payer can find what's returned to them.
    HoldToWaive,
    /// An agent's grants, so they can collect them. Tagged with the grant's
    /// reference, so its issuer finds a payment it already granted.
    AgentToGrant,
    /// The cash-outs an issuer is asked to pay, base = the issuer -- swept by
    /// its service in the order they arrive (`LinkQuery::after`).
    IssuerToRedemption,
    /// A cash-out's outcome, base = the cash-out, so its author finds it.
    RedemptionToOutcome,
    /// An issuer's profile, base = the issuer.
    IssuerToProfile,
    /// A grant's collection, base = the grant, so its recipient knows it's
    /// collected without reading back through their ledger.
    GrantToDeposit,
    /// An issuer's attestation of an agent's card, base = the agent.
    AgentToCardAttestation,
    /// An issuer withdrawing it, base = the agent.
    AgentToCardRevocation,
}

const _: () = assert!(LinkTypes::Version as u8 == handshake_integrity_support::versions::VERSION_LINK_TYPE, "Version must be the first link type");

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match classify(op.flattened::<EntryTypes, LinkTypes>()?)? {
        Checked::Create { entry, action } => match entry {
            EntryTypes::LedgerEntry(entry) => validate_entry(&entry, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::IssuerGrant(grant) => validate_grant(&grant, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::RedemptionOutcome(outcome) => validate_outcome(&outcome, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::IssuerProfile(profile) => validate_issuer_profile(&profile, action.author()),
            EntryTypes::CardAttestation(attestation) => validate_card_attestation(&attestation, action.author()),
            EntryTypes::CardRevocation(_) => require(handshake_governance::is_issuer(action.author())?, "only an issuer on the network's roster withdraws its word on a card"),
        },
        // An issuer keeps its profile current; nothing else changes.
        Checked::Update { entry: EntryTypes::IssuerProfile(profile), action } => {
            let prior = must_get_valid_record(action.original_action_address.clone())?;
            if decode::<IssuerProfile>(&prior).is_none() || prior.action().author() != action.author() {
                return invalid("an issuer changes only its own profile");
            }
            validate_issuer_profile(&profile, action.author())
        }
        Checked::Update { .. } => invalid("ledger entries can't be changed"),
        Checked::Delete { .. } => invalid("ledger entries can't be deleted"),
        Checked::CreateLink { link_type: LinkTypes::Version, action } => handshake_integrity_support::versions::validate_version_link(&action.base_address, &action.target_address, &action.tag, action.author()),
        Checked::DeleteLink { link_type: LinkTypes::Version, .. } => Ok(ValidateCallbackResult::Invalid("an entry's versions stay linked".into())),
        Checked::CreateLink { link_type, action } => validate_create_link(link_type, &action.base_address, &action.target_address, &action.tag, action.author()),
        Checked::DeleteLink { .. } => invalid("ledger links can't be deleted"),
        Checked::Other => valid(),
    }
}

fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, tag: &LinkTag, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = linked_record(target)? else {
        return invalid("ledger links must target a record");
    };
    if author != record.action().author() {
        return invalid("a ledger link must be authored by the author of the entry it indexes");
    }
    let expected: Option<AnyLinkableHash> = match link_type {
        // Validated as a version (`validate`).
        LinkTypes::Version => return invalid("a version link is validated as one"),
        LinkTypes::OrderToHold => match decode::<LedgerEntry>(&record).map(|e| e.kind) {
            Some(LedgerKind::Hold { order, .. }) => Some(order.into()),
            _ => None,
        },
        LinkTypes::HoldToWaive => match decode::<LedgerEntry>(&record).map(|e| e.kind) {
            Some(LedgerKind::Waive { hold, .. }) => Some(hold.into()),
            _ => None,
        },
        LinkTypes::AgentToGrant => match decode::<IssuerGrant>(&record) {
            Some(grant) if tag.0 != grant.reference.as_bytes() => return invalid("a grant's link is tagged with its reference"),
            grant => grant.map(|grant| grant.to.into()),
        },
        LinkTypes::GrantToDeposit => match decode::<LedgerEntry>(&record).map(|e| e.kind) {
            Some(LedgerKind::Deposit { grant } | LedgerKind::Returned { grant, .. }) => Some(grant.into()),
            _ => None,
        },
        LinkTypes::IssuerToRedemption => match decode::<LedgerEntry>(&record).map(|e| e.kind) {
            Some(LedgerKind::Redeem { issuer, .. }) => Some(issuer.into()),
            _ => None,
        },
        LinkTypes::RedemptionToOutcome => decode::<RedemptionOutcome>(&record).map(|o| o.redemption.into()),
        LinkTypes::AgentToCardAttestation => decode::<CardAttestation>(&record).map(|a| a.agent.into()),
        LinkTypes::AgentToCardRevocation => decode::<CardRevocation>(&record).map(|r| r.agent.into()),
        LinkTypes::IssuerToProfile => decode::<IssuerProfile>(&record).filter(|_| matches!(record.action().data, ActionData::Create(_))).map(|_| author.clone().into()),
    };
    match expected {
        Some(expected) => require(&expected == base, "a ledger link must sit under the order, hold, grant or agent its entry is about"),
        None => invalid("a ledger link's target is not the entry its link type indexes"),
    }
}

/// One ledger action on an agent's chain, as walked by validation.
struct ChainEntry {
    hash: ActionHash,
    entry: LedgerEntry,
}

fn is_ledger_entry(action: &Action) -> ExternResult<bool> {
    let ActionData::Create(create) = &action.data else { return Ok(false) };
    Ok(create.entry_type == EntryType::try_from(UnitEntryTypes::LedgerEntry)?)
}

/// Every ledger entry on `agent`'s chain from `chain_top` back to the first
/// action at or after `since`, newest first -- none if the chain hadn't
/// reached `since` yet.
fn ledger_since(agent: &AgentPubKey, chain_top: &ActionHash, since: Timestamp) -> ExternResult<Vec<ChainEntry>> {
    Ok(ledger_of(handshake_integrity_support::chain::activity_since(agent, chain_top, since)?)?.0)
}

/// The same, and whether the walk passed the chain's close (`close_chain`,
/// moving the account to another network) -- after which nothing more moves
/// money here. Holochain's own check of that runs only where the agent's
/// activity is held, not where a record is: a counterparty must_get-ing a
/// hold wouldn't see it. So the ledger checks for itself.
fn ledger_walk(agent: &AgentPubKey, filter: ChainFilter) -> ExternResult<(Vec<ChainEntry>, bool)> {
    ledger_of(must_get_agent_activity(agent.clone(), filter)?)
}

/// The ledger entries among `activity`, and whether it holds the chain's close.
fn ledger_of(activity: Vec<AgentActivity>) -> ExternResult<(Vec<ChainEntry>, bool)> {
    let mut entries = Vec::new();
    let mut closed = false;
    for item in activity {
        let action = &item.action.hashed.content;
        if matches!(action.data, ActionData::CloseChain(_)) {
            closed = true;
            continue;
        }
        if !is_ledger_entry(action)? {
            continue;
        }
        let ActionData::Create(create) = &action.data else { continue };
        let Entry::App(bytes) = handshake_integrity_support::chain::entry_of(&item, &create.entry_hash)? else { continue };
        let Ok(entry) = LedgerEntry::try_from(SerializedBytes::from(bytes)) else { continue };
        entries.push(ChainEntry { hash: item.action.hashed.hash.clone(), entry });
    }
    Ok((entries, closed))
}

fn validate_entry(entry: &LedgerEntry, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("a ledger entry can't open a chain") };

    // Its place on the author's chain: right after their previous entry.
    let prior = match &entry.previous {
        Some(previous) => {
            let record = must_get_valid_record(previous.clone())?;
            let Some(prior) = decode::<LedgerEntry>(&record) else { return invalid("previous must be a ledger entry") };
            if record.action().author() != author {
                return invalid("previous must be the author's own ledger entry");
            }
            let (between, closed) = ledger_walk(author, ChainFilter::until_hash(prev_action.clone(), previous.clone()))?;
            if between.iter().any(|e| &e.hash != previous) {
                return invalid("previous must be the author's latest ledger entry");
            }
            if closed {
                return invalid("this account's chain is closed: it moved to another network");
            }
            (prior.balance, prior.in_hand)
        }
        None => {
            // Its first: no ledger entry before it, read from the actions alone.
            let (mut earlier, mut closed) = (false, false);
            handshake_integrity_support::chain::walk_back(author, prev_action, |item| {
                let action = &item.action.hashed.content;
                closed |= matches!(action.data, ActionData::CloseChain(_));
                earlier = is_ledger_entry(action)?;
                Ok(if earlier { core::ops::ControlFlow::Break(()) } else { core::ops::ControlFlow::Continue(()) })
            })?;
            if earlier {
                return invalid("previous must name the author's latest ledger entry");
            }
            if closed {
                return invalid("this account's chain is closed: it moved to another network");
            }
            (0, InHand::default())
        }
    };
    let (prior_balance, prior_in_hand) = prior;

    // The arithmetic, and the credit limit on what's spent.
    let amount = i128::from(entry.amount);
    let (expected, debit) = match &entry.kind {
        LedgerKind::Deposit { .. } | LedgerKind::Collect { .. } | LedgerKind::Unstake { .. } | LedgerKind::Reclaim { .. } | LedgerKind::Returned { .. } => (i128::from(prior_balance) + amount, false),
        LedgerKind::Hold { .. } | LedgerKind::Stake { .. } => (i128::from(prior_balance) - amount, true),
        // Credit is never cashed out: only money the author has.
        LedgerKind::Redeem { .. } => {
            if i128::from(prior_balance) - amount < 0 {
                return invalid("a cash-out can't take a balance below zero");
            }
            (i128::from(prior_balance) - amount, true)
        }
        LedgerKind::Waive { .. } | LedgerKind::Forfeit { .. } => {
            if entry.amount != 0 {
                return invalid("waiving or forfeiting changes nothing in the author's own balance");
            }
            (i128::from(prior_balance), false)
        }
    };
    if i128::from(entry.balance) != expected {
        return invalid("a ledger entry's balance must follow from the author's previous one");
    }
    if debit && expected < -i128::from(handshake_governance::credit_limit_cents()) {
        return invalid("that would take the balance past the network's credit limit");
    }

    let kind_result = match &entry.kind {
        LedgerKind::Deposit { grant } => validate_deposit(entry, grant, author, at, prev_action),
        LedgerKind::Hold { order, purpose } => validate_hold(entry, order, purpose, author),
        LedgerKind::Collect { hold, portion, basis } => validate_collect(entry, hold, *portion, basis, author, at, prev_action),
        LedgerKind::Waive { hold, portion } => validate_waive(hold, *portion, author, at, prev_action),
        LedgerKind::Forfeit { hold, basis } => validate_forfeit(hold, basis, author, at, prev_action),
        LedgerKind::Stake { catalog } => validate_stake(entry, catalog, author),
        LedgerKind::Unstake { stake, delisting } => validate_unstake(entry, stake, delisting, author, prev_action),
        LedgerKind::Redeem { issuer, instructions } => validate_redeem(entry, issuer, instructions.as_ref(), author),
        LedgerKind::Reclaim { redemption, outcome } => validate_reclaim(entry, redemption, outcome, author, prev_action),
        LedgerKind::Returned { grant, hold, portion } => validate_returned(entry, grant, hold, *portion, author, at, prev_action),
    }?;
    if !matches!(kind_result, ValidateCallbackResult::Valid) {
        return Ok(kind_result);
    }

    // The orders in hand, and the limit on them.
    match in_hand_after(prior_in_hand, &entry.kind, author)? {
        Ok(in_hand) if in_hand == entry.in_hand => valid(),
        Ok(_) => invalid("a ledger entry's orders in hand must follow from the author's previous one"),
        Err(reason) => invalid(reason),
    }
}

/// The orders `author` has in hand after `kind`, from `prior` -- or why
/// `kind` would break the limit on them.
fn in_hand_after(prior: InHand, kind: &LedgerKind, author: &AgentPubKey) -> ExternResult<Result<InHand, &'static str>> {
    Ok(match kind {
        // Picking an order up: its driver's collateral.
        LedgerKind::Hold { order, purpose: purpose @ HoldPurpose::Collateral { .. } } => match hold_context(order, purpose)? {
            Ok((terms, _)) => prior.taking(terms.priority, handshake_governance::max_concurrent_deliveries()).map_err(CarryRefusal::rule),
            Err(reason) => Err(reason),
        },
        // Settling one: the driver's collateral back (from the hold, or an
        // issuer in its place), or forfeited.
        LedgerKind::Collect { hold, portion: Portion::Collateral, .. } | LedgerKind::Returned { hold, portion: Portion::Collateral, .. } | LedgerKind::Forfeit { hold, .. } => match hold_of(hold)? {
            Ok(hold) if &hold.payer == author => prior.settling().ok_or("no order is in hand to settle"),
            Ok(_) => Ok(prior),
            Err(reason) => Err(reason),
        },
        _ => Ok(prior),
    })
}

// --- cashing out ---
