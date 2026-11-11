// The Stripe adapter against Stripe's answers (as its test mode gave them):
// what it sends -- manual capture, cards only, the idempotency key, never
// more than asked -- and how it reads what comes back. Keys are checked
// before anything is sent: a full secret key is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkKeys, declineCode, stripeProcessor } from "../src/adapters/stripe.ts";
import { Refused, Retry } from "../src/processor.ts";

const KEYS = { publishable_key: "pk_test_abcdefghijklmnop", restricted_key: "rk_test_abcdefghijklmnop" };

/// Stripe, answering each request with the next of `answers`.
function stripe(answers: [number, unknown][]) {
  const sent: { url: string; method: string; headers: Record<string, string>; body: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: new URLSearchParams((init.body as string) ?? "") });
    const [status, json] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { sent, processor: stripeProcessor(KEYS, "USD", fetchImpl) };
}

const request = { amount: 2500, currency: "USD", token: "pm_card_visa", savedAs: null, save: false, tag: "hs_0123456789abcdef", idempotencyKey: "k".repeat(40) };

test("keys: a publishable and a restricted key of one mode; a full secret key never", () => {
  assert.deepEqual(checkKeys(KEYS), { live: false });
  assert.throws(() => checkKeys({ ...KEYS, restricted_key: "sk_test_abcdefghijklmnop" }), Refused);
  assert.throws(() => checkKeys({ ...KEYS, restricted_key: "rk_live_abcdefghijklmnop" }), /different modes/);
  assert.throws(() => checkKeys({ ...KEYS, publishable_key: "nope" }), Refused);
});

test("an authorization is a manual-capture card intent, for exactly the amount, under the idempotency key", async () => {
  const { sent, processor } = stripe([[200, { id: "pi_1", status: "requires_capture", latest_charge: { payment_method_details: { card: { fingerprint: "fp_1" } } } }]]);
  const held = await processor.authorize(request);
  assert.deepEqual(held, { status: "held", reference: "pi_1", fingerprint: "fp_1", savedAs: null });
  const [call] = sent;
  assert.equal(call.url, "https://api.stripe.com/v1/payment_intents");
  assert.equal(call.headers["Idempotency-Key"], request.idempotencyKey);
  assert.equal(call.headers.Authorization, `Bearer ${KEYS.restricted_key}`);
  assert.equal(call.body.get("amount"), "2500");
  assert.equal(call.body.get("currency"), "usd");
  assert.equal(call.body.get("capture_method"), "manual");
  assert.equal(call.body.get("automatic_payment_methods[allow_redirects]"), "never");
  assert.equal(call.body.get("metadata[order]"), request.tag, "the order's opaque tag, nothing more");
});

test("a card kept for next time is saved to a customer, and used off-session after", async () => {
  const { sent, processor } = stripe([
    [200, { id: "cus_1" }],
    [200, { id: "pi_2", status: "requires_capture", customer: "cus_1", payment_method: "pm_1", setup_future_usage: "off_session", latest_charge: null }],
    [200, { id: "pi_3", status: "requires_capture", latest_charge: null }],
  ]);
  const first = await processor.authorize({ ...request, save: true });
  assert.equal(first.status === "held" && first.savedAs, "cus_1:pm_1");
  assert.equal(sent[1].body.get("setup_future_usage"), "off_session");
  await processor.authorize({ ...request, token: null, savedAs: "cus_1:pm_1" });
  assert.equal(sent[2].body.get("customer"), "cus_1");
  assert.equal(sent[2].body.get("payment_method"), "pm_1");
  assert.equal(sent[2].body.get("off_session"), "true");
});

test("declines and challenges read as the network's codes", async () => {
  const { processor } = stripe([
    [402, { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds" } }],
    [200, { id: "pi_4", status: "requires_action", client_secret: "pi_4_secret_x" }],
  ]);
  assert.deepEqual(await processor.authorize(request), { status: "declined", code: "InsufficientFunds" });
  assert.deepEqual(await processor.authorize(request), { status: "action", reference: "pi_4", action: "pi_4_secret_x" });
  assert.equal(declineCode({ code: "authentication_required" }), "ActionFailed");
  assert.equal(declineCode({ decline_code: "stolen_card" }), "Declined");
});

test("busy or unreachable is tried again; a key Stripe refuses is said plainly", async () => {
  await assert.rejects(stripe([[503, {}]]).processor.authorize(request), Retry);
  await assert.rejects(stripe([[401, {}]]).processor.authorize(request), /no longer accepts/);
  await assert.rejects(stripe([[403, {}]]).processor.capture("pi_1", 100, "k"), /restricted key can't do this/);
});

test("capture takes what's due; nothing releases it; done before is done", async () => {
  const { sent, processor } = stripe([
    [200, { id: "pi_1", status: "succeeded" }],
    [200, { id: "pi_2", status: "canceled" }],
    [400, { error: { code: "payment_intent_unexpected_state", message: "already captured" } }],
    [200, { id: "pi_3", status: "succeeded", amount_received: 900 }],
    [400, { error: { code: "payment_intent_unexpected_state", message: "already captured" } }],
    [200, { id: "pi_4", status: "succeeded", amount_received: 1000 }],
  ]);
  await processor.capture("pi_1", 1800, "a");
  assert.match(sent[0].url, /pi_1\/capture$/);
  assert.equal(sent[0].body.get("amount_to_capture"), "1800");
  await processor.capture("pi_2", 0, "b");
  assert.match(sent[1].url, /pi_2\/cancel$/, "nothing due: released, not captured");
  await processor.capture("pi_3", 900, "c");
  await assert.rejects(processor.capture("pi_4", 900, "d"), /succeeded on Stripe, not as the network has it/, "a different amount isn't taken as done");
});

test("a refund is of the intent, for the award", async () => {
  const { sent, processor } = stripe([[200, { id: "re_1" }]]);
  await processor.refund("pi_1", 1500, "r");
  assert.equal(sent[0].body.get("payment_intent"), "pi_1");
  assert.equal(sent[0].body.get("amount"), "1500");
  assert.equal(sent[0].headers["Idempotency-Key"], "r");
});

test("a card withdrawn is detached from its customer at Stripe's own path; one already gone is no failure", async () => {
  const { sent, processor } = stripe([[200, { id: "pm_1", customer: null }], [404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such PaymentMethod" } }]]);
  await processor.forget("cus_1:pm_1");
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].url, "https://api.stripe.com/v1/payment_methods/pm_1/detach");
  await processor.forget("cus_1:pm_1");
  assert.equal(sent.length, 2);
  await assert.rejects(processor.forget("cus_1:not-a-card"), Refused);
  assert.equal(sent.length, 2, "nothing sent for what isn't a card");
});
