// The pay sheet makes its card form afresh whenever what it pays changes:
// the cart repriced while it's open (a sale ending, the menu changing) gets
// a new form for the new amount -- the form, its wallet buttons and the
// amount shown always the same one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { paySheetKey } from "../src/lib/payments/paySheetKey";
import type { PaymentProfile } from "../src/holochain/types";

const profile = { processor: "Stripe", public_key: "pk_test_a", account: "acct_1", live: false, country: "US" } as PaymentProfile;

test("the cart's total changing while the sheet is open makes a new card form", () => {
  const before = paySheetKey(profile, 2_500, "USD");
  assert.equal(paySheetKey(profile, 2_500, "USD"), before, "re-rendered at the same amount: the same form, a card half-typed kept");
  assert.notEqual(paySheetKey(profile, 2_150, "USD"), before, "a sale ended: a new form, for the new amount");
  assert.notEqual(paySheetKey(profile, 2_500, "EUR"), before, "another currency");
  assert.notEqual(paySheetKey({ ...profile, public_key: "pk_test_b" }, 2_500, "USD"), before, "the payee's processor keys changed");
});
