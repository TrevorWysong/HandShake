// The network's rules for direct payments that direct-payments.test.ts
// doesn't walk through an order: what a payment profile may say, how many
// cards a payer may try on a leg, one hold per leg, one settlement per hold
// (and only by its holder, for what it claims), refunds only by whoever
// captured and only for a ruling, a store's agent asked to hold only what
// its order still needs, and the most stores one account opens. Forgeries
// are written raw (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { TEST_CARD, actionHash, heldBy, holdOf, offerCard, retryUntil, retryUntilOk, retryingCaller, ST_PETE, testApp, useTestCoordinators } from "./helpers.js";

const FOOD = 600;

await runScenario(async (scenario) => {
  const [customer, store, driver, other] = await scenario.addPlayersWithApps([testApp, testApp, testApp, testApp]);
  const all = [customer, store, driver, other];
  await scenario.shareAllAgents();
  for (const p of all) await useTestCoordinators(p, ["dispatch"]);
  await useTestCoordinators(store, ["catalog"]);
  const sync = (from = customer) => dhtSync(all, from.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const raw = (p: typeof customer, record: unknown) => p.cells[0].callZome<Uint8Array>({ zome_name: "dispatch", fn_name: "create_raw_payment_record_for_testing", payload: record });

  for (const p of [driver, other]) await call(p, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: Date.now() * 1000 });
  const shop = actionHash(await call(store, "catalog")<HcRecord>("publish_catalog", { business_name: "Cara's", location: ST_PETE }));
  const item = actionHash(await call(store, "catalog")<HcRecord>("add_menu_item", { catalog_ref: shop, name: "Empanada", price_cents: FOOD, available: true }));
  await sync(store);
  const deliver = async () => {
    const order = actionHash(
      await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: store.agentPubKey, catalog_ref: shop, items: [{ item_ref: item, quantity: 1 }], order_total: FOOD, dropoff: ST_PETE, max_delivery_fee: 800 })),
    );
    await sync();
    return order;
  };

  // ===== What a payment profile may say =====
  const profile = (fields: Record<string, unknown>) => raw(store, { Profile: { processor: "Stripe", public_key: "pk_test_abcdefghij", account: "", live: false, country: "", ...fields } });
  await assert.rejects(profile({ public_key: "pk_live_abcdefghij", live: true }), /this network's payments are tests/, "a test network takes no live account");
  await assert.rejects(profile({ public_key: "sk_test_abcdefghij" }), /publishable key starts pk_test_/, "a secret key is never published");
  await assert.rejects(profile({ processor: "Square", public_key: "sandbox-sq0idb-abcdefghij", account: "L1234567" }), /names its country/, "Square's names its country");
  await assert.rejects(profile({ country: "us" }), /two capital letters/);
  await assert.rejects(profile({ account: "acct_1" }), /Stripe names none/);
  await call(store, "dispatch")("set_payment_profile", { processor: "Test", public_key: "test", account: "", live: false, country: "" });
  await sync(store);
  const published = await retryUntil(() => call(customer, "dispatch")<{ processor: string } | null>("payment_profile_of", store.agentPubKey), (p) => p !== null);
  assert.equal(published?.processor, "Test", "a test network takes the test processor");
  console.log("[PASS] a payment profile is of the network's kind, says what its processor needs, and never names a secret");

  // ===== Cards tried on a leg, and one hold per leg =====
  const capped = await deliver();
  for (let i = 0; i < 6; i++) await offerCard(customer, capped, "Customer");
  await assert.rejects(call(customer, "dispatch")("offer_payment", { order: capped, leg: "Customer", payment: { token: TEST_CARD, save: false }, resumes: null }), /too many payment attempts/, "no running card after card through a store");
  const held = await deliver();
  await offerCard(customer, held, "Customer");
  await sync();
  await heldBy(store, held, "Customer", all);
  const second = await offerCard(customer, held, "Customer");
  await sync();
  const [payment] = await call(customer, "dispatch")<{ held: number }[]>("order_payments", held);
  await assert.rejects(raw(store, { Hold: { offer: second, amount: payment.held, reference: "pi_again" } }), /already held/, "a leg is held once");
  console.log("[PASS] a payer tries a bounded number of cards on a leg, and its payee holds it once");

  // ===== Settling: by its holder, for what it claims, once =====
  const hold = (await holdOf(store, held, "Customer"))!;
  await assert.rejects(raw(driver, { Settlement: { hold, captured: 0, claims: [] } }), /settled by whoever held it/, "nobody settles another's hold");
  await assert.rejects(raw(store, { Settlement: { hold, captured: 100, claims: [] } }), /captures exactly what it claims/, "a capture is exactly what its claims add up to");
  await assert.rejects(
    raw(store, { Settlement: { hold, captured: FOOD, claims: [{ part: { purpose: "Food", portion: "Food" }, basis: held, via: null }] } }),
    /entitles no payment/,
    "nor claims the food on no decision that entitles it",
  );
  const released = await raw(store, { Settlement: { hold, captured: 0, claims: [] } });
  await assert.rejects(raw(store, { Settlement: { hold, captured: 0, claims: [] } }), /already settled/, "a hold is settled once");
  console.log("[PASS] a hold is settled once, by its holder, for exactly what it can claim");

  // ===== Refunds: by whoever captured, for a ruling =====
  await assert.rejects(raw(other, { Refund: { settlement: released, ruling: held, amount: 1 } }), /whoever captured the payment/);
  await assert.rejects(raw(store, { Refund: { settlement: released, ruling: held, amount: 1 } }), /pays a ruling/, "a refund pays a ruling, not anything");
  console.log("[PASS] a refund is the capturer's own, and only for a ruling");

  // ===== A store's agent holds only what its order still needs =====
  const contested = await deliver();
  await offerCard(customer, contested, "Customer");
  await sync();
  await heldBy(store, contested, "Customer", all);
  await retryUntilOk(() => call(store, "dispatch")("accept_delivery_order", { order_original_action: contested }));
  await sync(store);
  const bidOf = async (p: typeof customer) => actionHash(await retryUntilOk(() => call(p, "dispatch")<HcRecord>("submit_bid", { order_ref: contested, eta_seconds: 600, price_offer: 500 })));
  const chosen = await bidOf(driver);
  const passedOver = await bidOf(other);
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("accept_bid", { order_original_action: contested, bid_action: chosen }));
  await sync();
  await offerCard(other, contested, { Collateral: { bid: passedOver } });
  await offerCard(driver, contested, { Collateral: { bid: chosen } });
  await sync();
  type Due = { Authorize?: { order: Uint8Array; leg: unknown } };
  const collateralDue = (due: Due[]) =>
    due.filter((d) => d.Authorize && Buffer.from(d.Authorize.order).equals(Buffer.from(contested))).map((d) => d.Authorize!.leg as { Collateral?: { bid: Uint8Array } }).filter((leg) => leg.Collateral);
  const due = await retryUntil(() => call(store, "dispatch")<Due[]>("payments_due", null).then(collateralDue), (legs) => legs.length > 0);
  assert.equal(due.length, 1, "one collateral to hold");
  assert.ok(Buffer.from(due[0].Collateral!.bid).equals(Buffer.from(chosen)), "the chosen driver's -- never a card from a bid the order passed over");
  await retryUntilOk(() => call(customer, "dispatch")("cancel_order", capped));
  await sync();
  const onCancelled = await call(store, "dispatch")<Due[]>("payments_due", null);
  assert.ok(!onCancelled.some((d) => d.Authorize && Buffer.from(d.Authorize.order).equals(Buffer.from(capped))), "and nothing on an order that's over");
  console.log("[PASS] a store's agent is asked to hold only what an order still needs, from the driver it has");

  // ===== The most stores one account opens =====
  for (let n = 2; n <= 10; n++) await call(store, "catalog")("publish_catalog", { business_name: `Cara's ${n}`, location: ST_PETE });
  await assert.rejects(store.cells[0].callZome({ zome_name: "catalog", fn_name: "publish_catalog", payload: { business_name: "Cara's 11", location: ST_PETE } }), /at most 10 stores/);
  console.log("[PASS] an account opens at most ten stores");
});
