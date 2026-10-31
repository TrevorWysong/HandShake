// What keeps a store's generosity from being farmed, and a key from minting
// without end: an issuer issues at most the network's daily limit; a store's
// offers for newcomers go only to accounts whose card an issuer vouched for
// (one real card, one account); and a customer who keeps calling off orders
// before the store can answer has their next ones declined. Forgeries are
// written raw (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, retryUntil, retryUntilOk, retryingCaller, setupPlayersWithProperties, useTestCoordinators } from "./helpers.js";

const DAILY = 10_000;
const PRICE = 500;
const OFF = 100;

await runScenario(async (scenario) => {
  const [issuer, known, fresh, merchant] = await setupPlayersWithProperties(scenario, 4, (keys) => ({ issuers: [keys[0]], credit_limit_cents: 0, issuer_daily_limit_cents: DAILY }));
  const all = [issuer, known, fresh, merchant];
  for (const p of [known, fresh]) await useTestCoordinators(p, ["dispatch"]);
  const sync = () => dhtSync(all, issuer.cells[0].cell_id[0]);
  const call = (p: typeof issuer, zome: string) => retryingCaller(p.cells[0], zome);

  // ===== An issuer issues no more than the daily limit =====
  await call(issuer, "ledger")("issue_grant", { to: known.agentPubKey, amount: 6000, reference: "pay-1" });
  await call(issuer, "ledger")("issue_grant", { to: fresh.agentPubKey, amount: 3000, reference: "pay-2" });
  await assert.rejects(call(issuer, "ledger")("issue_grant", { to: fresh.agentPubKey, amount: 2000, reference: "pay-3" }), /daily limit/, "past the limit in 24 hours");
  await call(issuer, "ledger")("issue_grant", { to: fresh.agentPubKey, amount: 1000, reference: "pay-4" });
  console.log("[PASS] an issuer issues at most the network's daily limit");

  // ===== A card is vouched for by an issuer only =====
  await assert.rejects(call(fresh, "ledger")("attest_card", fresh.agentPubKey), /only an issuer/);
  assert.equal(await call(merchant, "ledger")("card_verified", known.agentPubKey), false);
  await call(issuer, "ledger")("attest_card", known.agentPubKey);
  await sync();
  assert.equal(await retryUntil(() => call(merchant, "ledger")<boolean>("card_verified", known.agentPubKey), (v) => v), true);
  for (const p of [known, fresh]) await retryUntil(() => call(p, "ledger")<number>("collect_grants", null).then(() => call(p, "ledger")<number>("get_balance", p.agentPubKey)), (b) => b > 0, 30, 1000);
  console.log("[PASS] only an issuer vouches for a card");

  // ===== A newcomers' code needs a vouched-for card =====
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: PRICE, available: true }));
  const welcome = actionHash(
    await call(merchant, "catalog")<HcRecord>("create_promo_code", {
      catalog_ref: store, code: "WELCOME", requirement: "None", reward: { FlatOffSubtotal: OFF }, expires_at: null, auto_apply: false,
      limits: { first_order_only: true, per_customer: null, once_per: null, total: null },
    }),
  );
  await sync();
  const order = (p: typeof issuer, promo_code_ref: ActionHash | null = null) =>
    call(p, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: promo_code_ref ? PRICE - OFF : PRICE, promo_code_ref });
  const blocked = (p: typeof issuer) => call(p, "dispatch")<{ promo: ActionHash; blocked: unknown }[]>("my_promo_standing", store).then((list) => list[0].blocked);
  assert.equal(await retryUntil(() => blocked(fresh), (b) => b !== undefined), "CardNotVerified", "shown before they try");
  await assert.rejects(order(fresh, welcome), /verified card/);
  // Past the app: the store won't take it.
  const version = actionHash(await call(fresh, "catalog")<HcRecord>("get_catalog", store));
  const raw = actionHash(
    await call(fresh, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: fresh.agentPubKey, merchant: merchant.agentPubKey, catalog_ref: store, catalog_version: version,
      lines: [{ item_ref: stew, priced_version: stew, quantity: 1, selections: [] }],
      order_total: PRICE - OFF, status: "Placed", requested_at: Date.now() * 1000, kitchen_note: null, promo_code_ref: welcome, bag_claim_ref: null,
      loyalty_proof: [], rewards: null, cancellation: null, ready_by: null, food_hold: null, sealed_customer_name: null,
    }),
  );
  await sync();
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: raw }), /card isn't verified/, "nor the store");
  assert.equal(await blocked(known), null);
  const theirs = actionHash(await retryUntilOk(() => order(known, welcome)));
  await sync();
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: theirs }));
  console.log("[PASS] a newcomers' code goes only to an account whose card an issuer vouched for");

  // ===== Calling off order after order before the store answers =====
  await call(fresh, "dispatch")("cancel_pickup_order", raw);
  for (let i = 0; i < 2; i++) {
    const o = actionHash(await retryUntilOk(() => order(fresh)));
    await call(fresh, "dispatch")("cancel_pickup_order", o);
  }
  const next = actionHash(await retryUntilOk(() => order(fresh)));
  await sync();
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: next }), /called off several orders/);
  await retryUntilOk(() => call(merchant, "dispatch")("decline_pickup_order", { order_original_action: next, reason: "TooManyCancellations" }));
  console.log("[PASS] a customer who keeps calling off orders before the store answers has the next one declined");
});
