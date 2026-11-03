// Square and Clover against their documented answers -- what each adapter
// sends, and how it reads what comes back -- until they've run against the
// processors' sandboxes (DIRECT_PAYMENTS.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { squareProcessor, checkKeys as squareKeys } from "../src/adapters/square.ts";
import { cloverProcessor, fingerprintOf } from "../src/adapters/clover.ts";
import { Refused } from "../src/processor.ts";

/// A processor's API, answering each request with the next of `answers`.
function api(answers: [number, unknown][]) {
  const sent: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : null });
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
  assert.deepEqual([sent[1].method, sent[1].body.payment.amount_money.amount, sent[2].url.endsWith("/p1/complete")], ["PUT", 1800, true]);
  await square.capture("p2", 0, "k2");
  assert.ok(sent[4].url.endsWith("/p2/cancel"));
  await square.capture("p3", 1800, "k3");
  assert.equal(sent.length, 6, "already completed for that amount: done");
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
  assert.deepEqual([sent[4].url.endsWith("/v1/charges/c1/capture"), sent[4].body.amount], [true, 1800]);
  await clover.capture("c2", 0, "k2");
  assert.deepEqual([sent[6].url.endsWith("/v1/refunds"), sent[6].body.charge], [true, "c2"], "released by refunding it uncaptured");
});

test("clover: one card's fingerprint is the same whichever charge it's on", () => {
  const card = { first6: "424242", last4: "4242", exp_month: "12", exp_year: "2030" };
  assert.equal(fingerprintOf(card), fingerprintOf({ ...card }));
  assert.notEqual(fingerprintOf(card), fingerprintOf({ ...card, last4: "4243" }));
  assert.equal(fingerprintOf({ fingerprint: "clover-fp" }), "clover-fp");
  assert.equal(fingerprintOf({ last4: "4242" }), null);
});
