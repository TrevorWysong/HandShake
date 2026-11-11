// The adapters against the processors themselves, in their sandboxes -- what
// the unit tests (test/) can only take on trust from recorded answers. Each
// step goes through the adapter, exactly as the agent calls it, and is then
// read back from the processor directly, so what the processor did is
// checked, not what the adapter says it did. Never live keys:
//
//   STRIPE_PUBLISHABLE_KEY=pk_test_… STRIPE_RESTRICTED_KEY=rk_test_… npm run sandbox -- stripe
//   SQUARE_APPLICATION_ID=sandbox-sq0idb-… SQUARE_LOCATION_ID=L… SQUARE_ACCESS_TOKEN=E… npm run sandbox -- square
//
// Stripe's restricted key is the one DIRECT_PAYMENTS.md asks for: write on
// PaymentIntents, SetupIntents, Customers and PaymentMethods, and nothing
// more. With it, this also checks the key can't reach what the agent must
// never touch -- the balance, payouts, transfers and the rest -- read or
// write. Square's access tokens can't be narrowed so: that's said, not
// tested. It exits non-zero on any failure.
import { randomBytes } from "node:crypto";
import type { Authorization, Processor } from "../src/processor.ts";
import { checkKeys as checkStripe, stripeProcessor } from "../src/adapters/stripe.ts";
import { checkKeys as checkSquare, squareProcessor } from "../src/adapters/square.ts";

const CURRENCY = process.env.SANDBOX_CURRENCY ?? "USD";

const failures: string[] = [];
function check(passed: boolean, what: string, detail?: unknown) {
  console.log(`${passed ? "  ✓" : "  ✗"} ${what}${passed || detail === undefined ? "" : ` -- ${JSON.stringify(detail)}`}`);
  if (!passed) failures.push(what);
}

/// A fresh idempotency key, as the agent makes them: one per step.
const key = () => randomBytes(20).toString("hex");
const tag = () => `hs_${randomBytes(8).toString("hex")}`;

/// What a processor holds and what it shows of it, for one adapter.
interface Sandbox {
  name: string;
  processor: Processor;
  /// Card form tokens the sandbox answers in known ways.
  cards: { ok: string; declined: string; insufficient?: string; challenged?: string };
  /// The payment at `reference`, read from the processor directly.
  read(reference: string): Promise<{ status: "held" | "captured" | "released" | "other"; captured: number; refunded: number }>;
  /// Anything only this processor's checks need.
  extra?(): Promise<void>;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Set ${name} to your sandbox's key.`);
    process.exit(2);
  }
  return value;
}

function stripe(): Sandbox {
  const keys = { publishable_key: required("STRIPE_PUBLISHABLE_KEY"), restricted_key: required("STRIPE_RESTRICTED_KEY") };
  if (checkStripe(keys).live) refuseLive();
  const raw = async (method: "GET" | "POST", path: string, body?: string) => {
    const response = await fetch(`https://api.stripe.com/v1${path}`, { method, headers: { Authorization: `Bearer ${keys.restricted_key}`, "Content-Type": "application/x-www-form-urlencoded" }, body });
    return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, any> };
  };
  return {
    name: "Stripe",
    processor: stripeProcessor(keys, CURRENCY),
    cards: { ok: "pm_card_visa", declined: "pm_card_chargeDeclined", insufficient: "pm_card_chargeDeclinedInsufficientFunds", challenged: "pm_card_authenticationRequired" },
    async read(reference) {
      const { json: intent } = await raw("GET", `/payment_intents/${encodeURIComponent(reference)}?expand[]=latest_charge`);
      const status = intent.status === "requires_capture" ? "held" : intent.status === "succeeded" ? "captured" : intent.status === "canceled" ? "released" : "other";
      return { status, captured: intent.amount_received ?? 0, refunded: intent.latest_charge?.amount_refunded ?? 0 };
    },
    async extra() {
      console.log("What the restricted key can't reach:");
      // Each a 403 with Stripe's permission error -- not a 404 or a 400,
      // which would mean the key got in and the request was merely wrong.
      const forbidden: [method: "GET" | "POST", path: string, body?: string][] = [
        ["GET", "/balance"],
        ["GET", "/balance_transactions?limit=1"],
        ["GET", "/payouts?limit=1"],
        ["POST", "/payouts", `amount=100&currency=${CURRENCY.toLowerCase()}`],
        ["GET", "/transfers?limit=1"],
        ["POST", "/transfers", `amount=100&currency=${CURRENCY.toLowerCase()}&destination=acct_1`],
        ["GET", "/topups?limit=1"],
        ["GET", "/application_fees?limit=1"],
        ["GET", "/webhook_endpoints?limit=1"],
        ["POST", "/webhook_endpoints", "url=https%3A%2F%2Fexample.com%2F&enabled_events[]=*"],
        ["GET", "/products?limit=1"],
        ["GET", "/invoices?limit=1"],
        ["GET", "/subscriptions?limit=1"],
        ["GET", "/files?limit=1"],
        ["POST", "/accounts", "type=express"],
      ];
      for (const [method, path, body] of forbidden) {
        const { status, json } = await raw(method, path, body);
        check(status === 403, `${method} ${path.split("?")[0]} is refused`, { status, error: json.error?.type });
      }
    },
  };
}

function square(): Sandbox {
  const keys = { application_id: required("SQUARE_APPLICATION_ID"), location_id: required("SQUARE_LOCATION_ID"), access_token: required("SQUARE_ACCESS_TOKEN") };
  if (checkSquare(keys).live) refuseLive();
  const nonce = (value: string) => JSON.stringify({ nonce: value });
  return {
    name: "Square",
    processor: squareProcessor(keys, CURRENCY),
    // Square's sandbox has no nonce for insufficient funds, and asks the
    // bank in the card form, never here (the adapter's `resume`).
    cards: { ok: nonce("cnon:card-nonce-ok"), declined: nonce("cnon:card-nonce-declined") },
    async read(reference) {
      const get = async (path: string) => (await (await fetch(`https://connect.squareupsandbox.com/v2${path}`, { headers: { Authorization: `Bearer ${keys.access_token}`, "Square-Version": "2025-01-23" } })).json()) as Record<string, any>;
      const { payment } = await get(`/payments/${encodeURIComponent(reference)}`);
      const status = payment.status === "APPROVED" ? "held" : payment.status === "COMPLETED" ? "captured" : payment.status === "CANCELED" ? "released" : "other";
      // A refund is pending a while before the payment counts it: each read
      // from the refund itself.
      let refunded = 0;
      for (const id of payment.refund_ids ?? []) refunded += (await get(`/refunds/${encodeURIComponent(id)}`)).refund?.amount_money?.amount ?? 0;
      return { status, captured: status === "captured" ? payment.total_money?.amount ?? 0 : 0, refunded };
    },
    async extra() {
      console.log("Least privilege:");
      console.log("  - Square's personal access tokens can't be narrowed to payments: the agent calls only payments, refunds, customers and cards, but the token itself could do more. Use a location of HandShake's own.");
    },
  };
}

function refuseLive(): never {
  console.error("Those are live keys. This moves real money: use your sandbox's.");
  process.exit(2);
}

async function held(processor: Processor, amount: number, token: string, save = false): Promise<Authorization> {
  return processor.authorize({ amount, currency: CURRENCY, token, savedAs: null, save, tag: tag(), idempotencyKey: key() });
}

async function main() {
  const which = process.argv[2];
  const sandbox = which === "stripe" ? stripe() : which === "square" ? square() : null;
  if (!sandbox) {
    console.error("Say which processor: stripe or square.");
    process.exit(2);
  }
  const { processor, cards } = sandbox;
  console.log(`${sandbox.name}, in its sandbox:`);

  const connection = await processor.connect();
  check(!connection.live, "the keys reach a sandbox account, not a live one", connection);
  check(connection.currency.toUpperCase() === CURRENCY, `in the network's currency, ${CURRENCY}`, connection.currency);

  console.log("Holding and capturing:");
  const request = { amount: 2500, currency: CURRENCY, token: cards.ok, savedAs: null, save: false, tag: tag(), idempotencyKey: key() };
  const first = await processor.authorize(request);
  check(first.status === "held", "a card is held for the amount", first);
  if (first.status === "held") {
    const again = await processor.authorize(request);
    check(again.status === "held" && again.reference === first.reference, "asked again under the same idempotency key, it's the same hold, not a second", again);
    check((await sandbox.read(first.reference)).status === "held", "the processor shows it held, not charged");
    const capturing = key();
    await processor.capture(first.reference, 2000, capturing);
    await processor.capture(first.reference, 2000, capturing);
    const captured = await sandbox.read(first.reference);
    check(captured.status === "captured" && captured.captured === 2000, "part of it is captured -- once, though asked twice -- and the rest released", captured);
    await processor.capture(first.reference, 2000, key()).then(
      () => check(true, "a capture already done, asked under a new key, is done"),
      (err) => check(false, "a capture already done, asked under a new key, is done", String(err)),
    );
    await processor.capture(first.reference, 2500, key()).then(
      () => check(false, "capturing a different amount after is refused"),
      () => check(true, "capturing a different amount after is refused"),
    );
    const refunding = key();
    await processor.refund(first.reference, 500, refunding);
    await processor.refund(first.reference, 500, refunding);
    const refunded = await sandbox.read(first.reference);
    check(refunded.refunded === 500, "a refund is made once, though asked twice", refunded);
  }

  const over = await held(processor, 1000, cards.ok);
  if (over.status === "held") {
    await processor.capture(over.reference, 1500, key()).then(
      () => check(false, "capturing more than was held is refused"),
      () => check(true, "capturing more than was held is refused"),
    );
    const releasing = key();
    await processor.capture(over.reference, 0, releasing);
    await processor.capture(over.reference, 0, releasing);
    check((await sandbox.read(over.reference)).status === "released", "a hold is released for nothing, and releasing it again is no error");
  } else check(false, "a second card is held", over);

  console.log("Cards that don't go through:");
  check(JSON.stringify(await held(processor, 1000, cards.declined)) === JSON.stringify({ status: "declined", code: "Declined" }), "a declined card is declined");
  if (cards.insufficient) check(JSON.stringify(await held(processor, 1000, cards.insufficient)) === JSON.stringify({ status: "declined", code: "InsufficientFunds" }), "one without the funds says so");
  if (cards.challenged) {
    const challenged = await held(processor, 1000, cards.challenged);
    check(challenged.status === "action", "one its bank challenges asks the payer to confirm", challenged);
    if (challenged.status === "action") check((await processor.resume(challenged.reference, key())).status === "action", "and resumed before they have, still asks");
  }

  console.log("A card kept for next time:");
  const saving = await held(processor, 1200, cards.ok, true);
  if (saving.status === "held" && saving.savedAs) {
    const reused = await processor.authorize({ amount: 800, currency: CURRENCY, token: null, savedAs: saving.savedAs, save: false, tag: tag(), idempotencyKey: key() });
    check(reused.status === "held", "the kept card is held again without the payer", reused);
    for (const hold of [saving, reused]) if (hold.status === "held") await processor.capture(hold.reference, 0, key());
    await processor.forget(saving.savedAs);
    await processor.forget(saving.savedAs);
    const after = await processor.authorize({ amount: 800, currency: CURRENCY, token: null, savedAs: saving.savedAs, save: false, tag: tag(), idempotencyKey: key() }).catch((err) => ({ status: "error", err: String(err) }));
    check(after.status !== "held", "forgotten -- twice, without error -- it can't be charged again", after);
  } else check(false, "a card is kept when the payer asks", saving);

  await sandbox.extra?.();

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nEvery check passed.");
}

await main();
