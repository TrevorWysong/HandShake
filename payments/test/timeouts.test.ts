// A processor that never answers holds up nothing for long: each request
// has a deadline (`PROCESSOR_TIMEOUT_MS`), after which it's given up as a
// `Retry` -- the same request, by its idempotency key, next round -- so one
// hung connection can't stall a round, and every payment after it. An
// answer cut off partway is no answer either, never taken for an empty one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cloverProcessor } from "../src/adapters/clover.ts";
import { squareProcessor } from "../src/adapters/square.ts";
import { stripeProcessor } from "../src/adapters/stripe.ts";
import { Retry } from "../src/processor.ts";

/// A connection that never answers, until the request's deadline aborts it.
const hung = (async (_url: string, init?: RequestInit) =>
  new Promise<Response>((_, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal!.reason)))) as typeof fetch;

/// One that starts answering, then stalls until the deadline cuts it off.
const stalls = (async (_url: string, init?: RequestInit) => {
  const body = new ReadableStream({ start: (controller) => init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason)) });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const processors = (fetchImpl: typeof fetch) => ({
  Stripe: stripeProcessor({ publishable_key: "pk_test_abcdefghijklmnop", restricted_key: "rk_test_abcdefghijklmnop" }, "USD", fetchImpl, 50),
  Square: squareProcessor({ application_id: "sandbox-sq0idb-abcdefghijklmnop", location_id: "L1234567", access_token: "EAAAabcdefghijklmnopqrstuvwxyz" }, "USD", fetchImpl, 50),
  Clover: cloverProcessor({ merchant_id: "ABCDEFGH12", public_key: "pakms_abcdefgh", private_token: "abcdefghijklmnopqrstuvwxyz" }, "USD", fetchImpl, 50),
});

for (const [why, fetchImpl] of [["never answers", hung], ["stops answering partway", stalls]] as const) {
  for (const [name, processor] of Object.entries(processors(fetchImpl))) {
    test(`${name}: a processor that ${why} is given up at the deadline, to try again`, async () => {
      const started = Date.now();
      await assert.rejects(processor.capture("ref_123", 100, "k".repeat(40)), (err: unknown) => err instanceof Retry);
      assert.ok(Date.now() - started < 5_000, "at the deadline, not whenever the connection gives up");
    });
  }
}
