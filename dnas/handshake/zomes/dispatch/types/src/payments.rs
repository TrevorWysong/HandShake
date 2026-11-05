//! The records of paying for an order directly (see `direct`): each written
//! on its author's own chain, linked under the order, and validated in
//! `dispatch_integrity::payments`. Nothing here moves money -- each payee's
//! own app does that on its own processor account, and records it here;
//! the network checks every amount against the order.
//!
//! 1. A payee publishes its `PaymentProfile`: which processor, and what a
//!    payer's app needs to show that processor's card form. Never a secret.
//! 2. A payer offers a payment (`PaymentOffer`): a single-use token from the
//!    processor's form, sealed to the payee -- or a request to use the card
//!    they saved with them.
//! 3. The payee's app authorizes it for exactly what the network says the
//!    leg needs, and records the `PaymentHold` -- or asks the payer for more
//!    (`PaymentAction`, 3-D Secure), or records it `PaymentDeclined`.
//! 4. Once the order's decisions are final, the payee captures what they're
//!    owed and releases the rest: one `PaymentSettlement`, every part of it
//!    resting on its basis.
//! 5. An arbiter's ruling for the customer is refunded from what the store
//!    captured (`PaymentRefund`).

use super::PaymentLeg;
use super::direct::Part;
use hdi::prelude::*;

/// The card processor a payee is paid through.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Processor {
    Stripe,
    Square,
    Clover,
    /// No processor at all: a stand-in for development and tests, whose
    /// payments move no money. Only ever on a test network.
    Test,
}

/// How a payee is paid: public, by design -- what any payer's app needs to
/// show the payee's processor's card form.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct PaymentProfile {
    pub processor: Processor,
    /// Stripe's publishable key, Square's application id, or Clover's public
    /// (PAKMS) key.
    pub public_key: String,
    /// Square's location id, or Clover's merchant id. Empty for Stripe.
    pub account: String,
    /// A live account, or a test one. Must be the network's kind
    /// (`handshake_governance::live_payments`).
    pub live: bool,
    /// The account's country, ISO 3166 (`US`), as its processor has it --
    /// what a wallet's payment sheet (Apple Pay, Google Pay) names as the
    /// seller's. Square's must say; empty where the processor didn't.
    #[serde(default)]
    pub country: String,
}

/// A payer's card for one leg of an order, for its payee.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct PaymentOffer {
    /// The order's original action.
    pub order: ActionHash,
    pub leg: PaymentLeg,
    /// Who it's offered to: the leg's payee, as validation checks -- so a
    /// payer's own chain says, without reading any order, whom they've kept
    /// a card with (`payments::saved_card_with`).
    pub payee: AgentPubKey,
    /// A single-use token from the payee's processor's card form, sealed to
    /// the payee. `None`: the card the payer saved with this payee.
    pub sealed_token: Option<XSalsa20Poly1305EncryptedData>,
    /// The payer lets the payee keep this card, for their later payments to
    /// them -- the same leg on later orders.
    pub save: bool,
    /// The `PaymentAction` this answers, once the payer has done it.
    pub resumes: Option<ActionHash>,
}

/// A payee's authorization of an offer, on its own processor account --
/// for exactly what the leg needs (`PaymentLeg::required`).
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct PaymentHold {
    pub offer: ActionHash,
    pub amount: u64,
    /// The processor's id for the authorization -- opaque to the network,
    /// what the payee's app captures or releases.
    pub reference: String,
}

/// What a payee's processor needs the payer to do before it authorizes --
/// 3-D Secure's challenge -- sealed to the payer.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct PaymentAction {
    pub offer: ActionHash,
    pub sealed: XSalsa20Poly1305EncryptedData,
}

/// Why an offer wasn't authorized -- in words the payer's app shows.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeclineCode {
    /// The card was declined.
    Declined,
    InsufficientFunds,
    /// The payer didn't complete what their card asked (3-D Secure).
    ActionFailed,
    /// There's no saved card to use, or it no longer works.
    NoSavedCard,
    /// The payee's limit on attempts was reached.
    TooManyAttempts,
    /// This card can't take this offer: a first-order deal it has used here.
    NotEligible,
    /// The payee's processor couldn't be reached, or refused.
    Unavailable,
}

/// A payee recording an offer it didn't authorize.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct PaymentDeclined {
    pub offer: ActionHash,
    pub code: DeclineCode,
}

/// One part of a settlement: the part, and what entitles the payee to it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub part: Part,
    /// The order's version or the store's decision it rests on.
    pub basis: ActionHash,
    /// For a part the store passes on to a driver: the driver's own
    /// `PaymentSettlement` that took it -- the store takes from the
    /// customer exactly what the driver took from the store.
    pub via: Option<ActionHash>,
}

/// A payee settling its hold: what it captured, part by part. Captures
/// nothing (no claims) to release it all.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct PaymentSettlement {
    pub hold: ActionHash,
    pub claims: Vec<Claim>,
    /// The sum of the claims: what the payee's processor captured.
    pub captured: u64,
}

/// A payer withdrawing the card they kept with `payee`: from here on it
/// pays nothing through HandShake, and the payee's agent deletes it from
/// its processor account. Written on the payer's own chain, so the
/// withdrawal is on their record -- the evidence for any charge after it.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that happens
// to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct SavedCardForgotten {
    pub payee: AgentPubKey,
}

/// A store refunding an arbiter's award to its customer, from what it
/// captured for the order.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct PaymentRefund {
    /// The store's settlement of the customer's payment.
    pub settlement: ActionHash,
    /// The arbiter's `Ruling` for the customer.
    pub ruling: ActionHash,
    pub amount: u64,
}
