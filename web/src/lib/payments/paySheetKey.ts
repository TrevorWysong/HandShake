import type { PaymentProfile } from "../../holochain/types";

/// What a card form is made for: the payee's processor and its keys, the
/// amount and the currency. The processor's form takes them as it's made --
/// Stripe's for the amount it confirms, Square's for its buyer
/// verification -- so whenever any of them changes, the form is made
/// afresh. The sheet never shows one amount while its form, or its wallet
/// buttons, would pay another.
export function paySheetKey(profile: PaymentProfile, amountCents: number, currency: string): string {
  return [profile.processor, profile.public_key, profile.account, currency, amountCents].join(":");
}
