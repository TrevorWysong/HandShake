// Square and Clover against their documented answers -- what each adapter
// sends, and how it reads what comes back -- until they've run against the
// processors' sandboxes (DIRECT_PAYMENTS.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { squareProcessor, checkKeys as squareKeys } from "../src/adapters/square.ts";
import { cloverProcessor, fingerprintOf } from "../src/adapters/clover.ts";
import { Refused } from "../src/processor.ts";

/// A request's body: JSON where it is, as sent otherwise.
const parsed = (body: string) => {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

/// A processor's API, answering each request with the next of `answers`.
function api(answers: [number, unknown][]) {
  const sent: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body ? parsed(init.body as string) : null });
    const [status, json] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const request = { amount: 2500, currency: "USD", token: JSON.stringify({ nonce: "cnon:abc", verification: "verf:xyz" }), savedAs: null, save: false, tag: "hs_0123456789abcdef", idempotencyKey: "k".repeat(40) };
const SQUARE = { application_id: "sandbox-sq0idb-abcdefghijklmnop", location_id: "L1234567", access_token: "EAAAabcdefghijklmnopqrstuvwxyz" };

test("square: a sandbox application is a test account; a malformed key is refused before anything's sent", () => {
  assert.deepEqual(squareKeys(SQUARE), { live: false });
  assert.deepEqual(squareKeys({ ...SQUARE, application_id: "sq0idp-abcdefghijklmnop" }), { live: true });
  assert.throws(() => squareKeys({ ...SQUARE, location_id: "no spaces!" }), Refused);
});

test("square: a delayed-capture payment at the payee's location, verified, for exactly the amount", async () => {
  const { sent, fetchImpl } = api([[200, { payment: { id: "p1", status: "APPROVED", card_details: { card: { fingerprint: "sq-fp" } } } }]]);
  const held = await squareProcessor(SQUARE, "USD", fetchImpl).authorize(request);
  assert.deepEqual(held, { status: "held", reference: "p1", fingerprint: "sq-fp", savedAs: null });
  assert.match(sent[0].url, /^https:\/\/connect\.squareupsandbox\.com\/v2\/payments$/);
  assert.deepEqual([sent[0].body.autocomplete, sent[0].body.amount_money, sent[0].body.location_id, sent[0].body.verification_token, sent[0].body.idempotency_key], [false, { amount: 2500, currency: "USD" }, "L1234567", "verf:xyz", request.idempotencyKey]);
});

test("square: what's due is completed -- lowered first when it's less -- and nothing due is cancelled", async () => {
  const { sent, fetchImpl } = api([
    [200, { payment: { id: "p1", status: "APPROVED", amount_money: { amount: 2500, currency: "USD" } } }],
    [200, {}],
    [200, {}],
    [200, { payment: { id: "p2", status: "APPROVED", amount_money: { amount: 2500, currency: "USD" } } }],
    [200, {}],
    [200, { payment: { id: "p3", status: "COMPLETED", amount_money: { amount: 1800, currency: "USD" } } }],
  ]);
  const square = squareProcessor(SQUARE, "USD", fetchImpl);
  await square.capture("p1", 1800, "k1");
  assert.deepEqual([sent[1].method, sent[1].body.payment.amount_money.amount, sent[2].url === "https://connect.squareupsandbox.com/v2/payments/p1/complete"], ["PUT", 1800, true]);
  await square.capture("p2", 0, "k2");
  assert.equal(sent[4].url, "https://connect.squareupsandbox.com/v2/payments/p2/cancel");
  await square.capture("p3", 1800, "k3");
  assert.equal(sent.length, 6, "already completed for that amount: done");
});

test("square: a location says its country; a wallet's card isn't kept on file, and a card Square won't keep doesn't undo its hold", async () => {
  const { fetchImpl } = api([[200, { location: { id: "L1234567", status: "ACTIVE", business_name: "Mo's", currency: "USD", country: "US" } }]]);
  const connection = await squareProcessor(SQUARE, "USD", fetchImpl).connect();
  assert.deepEqual([connection.country, connection.publicAccount], ["US", "L1234567"]);
  await assert.rejects(squareProcessor(SQUARE, "USD", api([[200, { location: { status: "ACTIVE" } }]]).fetchImpl).connect(), /which country/);

  const wallet = api([[200, { payment: { id: "p1", status: "APPROVED" } }]]);
  const held = await squareProcessor(SQUARE, "USD", wallet.fetchImpl).authorize({ ...request, token: JSON.stringify({ nonce: "wnon:1", verification: null, wallet: true }), save: true });
  assert.deepEqual([held.status, held.status === "held" && held.savedAs, wallet.sent.length], ["held", null, 1], "held, and nothing more asked of Square");

  const unkept = api([[200, { payment: { id: "p2", status: "APPROVED" } }], [400, { errors: [{ code: "BAD_REQUEST" }] }]]);
  const still = await squareProcessor(SQUARE, "USD", unkept.fetchImpl).authorize({ ...request, save: true });
  assert.deepEqual([still.status, still.status === "held" && still.savedAs], ["held", null]);
});

test("square: a declined card reads as the network's code", async () => {
  const { fetchImpl } = api([[400, { errors: [{ category: "PAYMENT_METHOD_ERROR", code: "INSUFFICIENT_FUNDS" }] }]]);
  assert.deepEqual(await squareProcessor(SQUARE, "USD", fetchImpl).authorize(request), { status: "declined", code: "InsufficientFunds" });
});

const CLOVER = { merchant_id: "ABCDEFGH12", public_key: "pakms_abcdefgh", private_token: "abcdefghijklmnopqrstuvwxyz" };

test("clover: the keys find their environment; an uncaptured charge, captured for what's due or released", async () => {
  const { sent, fetchImpl } = api([
    [401, {}],
    [200, { name: "Mo's", defaultCurrency: "USD" }],
    [200, { id: "c1", status: "succeeded", captured: false, source: { first6: "424242", last4: "4242", exp_month: "12", exp_year: "2030" } }],
    [200, { id: "c1", amount: 2500, captured: false }],
    [200, {}],
    [200, { id: "c2", amount: 2500, captured: false }],
    [200, {}],
  ]);
  const clover = cloverProcessor(CLOVER, "USD", fetchImpl);
  const connection = await clover.connect();
  assert.deepEqual([connection.live, connection.account, connection.publicAccount], [false, "Mo's", "ABCDEFGH12"], "production refused the token: it's a sandbox's");
  const held = await clover.authorize({ ...request, token: "clv_token" });
  assert.equal(held.status, "held");
  assert.ok(held.status === "held" && held.fingerprint?.startsWith("fp_"), "a fingerprint made from the card's details");
  assert.deepEqual([sent[2].body.capture, sent[2].body.amount, sent[2].headers["idempotency-key"]], [false, 2500, request.idempotencyKey]);
  await clover.capture("c1", 1800, "k1");
  assert.deepEqual([sent[4].url === "https://scl-sandbox.dev.clover.com/v1/charges/c1/capture", sent[4].body.amount], [true, 1800]);
  await clover.capture("c2", 0, "k2");
  assert.deepEqual([sent[6].url === "https://scl-sandbox.dev.clover.com/v1/refunds", sent[6].body.charge], [true, "c2"], "released by refunding it uncaptured");
});

test("clover: one card's fingerprint is the same whichever charge it's on", () => {
  const card = { first6: "424242", last4: "4242", exp_month: "12", exp_year: "2030" };
  assert.equal(fingerprintOf(card), fingerprintOf({ ...card }));
  assert.notEqual(fingerprintOf(card), fingerprintOf({ ...card, last4: "4243" }));
  assert.equal(fingerprintOf({ fingerprint: "clover-fp" }), "clover-fp");
  assert.equal(fingerprintOf({ last4: "4242" }), null);
});

test("a payer's token is only ever a fresh one from the card form -- never a saved card's id -- and nothing's sent for one", async () => {
  const { stripeProcessor } = await import("../src/adapters/stripe.ts");
  const cases = [
    [(f: typeof fetch) => squareProcessor(SQUARE, "USD", f), [JSON.stringify({ nonce: "ccof:customer-card-1" }), "cnon:not-json"]],
    [(f: typeof fetch) => cloverProcessor(CLOVER, "USD", f), ["CUSTOMER123", "clv_bad token"]],
    [(f: typeof fetch) => stripeProcessor({ publishable_key: "pk_test_abcdefghijklmnop", restricted_key: "rk_test_abcdefghijklmnop" }, "USD", f), ["cus_SomeoneElse", "src_123"]],
  ] as const;
  for (const [processor, tokens] of cases) {
    for (const token of tokens) {
      const { sent, fetchImpl } = api([]);
      assert.deepEqual(await processor(fetchImpl).authorize({ ...request, token }), { status: "declined", code: "Declined" }, token);
      assert.equal(sent.length, 0, token);
    }
  }
});

test("a withdrawn card is detached at Stripe and disabled at Square -- and only a card the agent kept is touched", async () => {
  const { stripeProcessor } = await import("../src/adapters/stripe.ts");
  const stripe = api([[200, {}]]);
  await stripeProcessor({ publishable_key: "pk_test_abcdefghijklmnop", restricted_key: "rk_test_abcdefghijklmnop" }, "USD", stripe.fetchImpl).forget("cus_A1:pm_B2");
  assert.equal(stripe.sent[0].url, "https://api.stripe.com/v1/payment_methods/pm_B2/detach");
  await assert.rejects(stripeProcessor({ publishable_key: "pk_test_abcdefghijklmnop", restricted_key: "rk_test_abcdefghijklmnop" }, "USD", api([]).fetchImpl).forget("cus_A1:../../v1/charges"), /isn't a card kept here/);
  const square = api([[200, {}]]);
  await squareProcessor(SQUARE, "USD", square.fetchImpl).forget("CUST1:ccof:CARD2");
  assert.equal(square.sent[0].url, "https://connect.squareupsandbox.com/v2/cards/ccof:CARD2/disable");
  await assert.rejects(squareProcessor(SQUARE, "USD", api([]).fetchImpl).forget("CUST1:a/b"), /isn't a card kept here/);
});

test("clover: a withdrawn card is revoked; a customer already gone is no failure", async () => {
  const clover = (answers: [number, unknown][]) => {
    const made = api([[200, { name: "Shop", defaultCurrency: "USD" }], ...answers]);
    return { ...made, processor: cloverProcessor(CLOVER, "USD", made.fetchImpl) };
  };
  const kept = clover([[200, { id: "CUST1", sources: { data: [{ id: "CARD2" }] } }], [200, {}]]);
  await kept.processor.forget("CUST1");
  assert.equal(kept.sent.at(-1)!.method, "DELETE");
  assert.equal(kept.sent.at(-1)!.url, "https://scl.clover.com/v1/customers/CUST1/sources/CARD2");
  await clover([[404, {}]]).processor.forget("CUST1");
  await assert.rejects(clover([]).processor.forget("../v1/charges"), /isn't a card kept here/);
  await assert.rejects(clover([[200, { id: "CUST1" }]]).processor.forget("CUST1"), /didn't list/, "never quietly done without having deleted it");
});
