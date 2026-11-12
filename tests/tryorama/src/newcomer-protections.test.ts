// What keeps a store's generosity from being farmed: a store's offers for
// newcomers go only to a customer's first order there (one card each is the
// store's payment agent's to check, by its processor's card fingerprint);
// and a customer who keeps calling off orders before the store can answer
// has their next ones declined -- and, across every store, can't order
// again for a day past the network's allowance. Forgeries are written raw
// (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, retryUntil, retryUntilOk, retryingCaller, setupPlayersWithProperties, useTestCoordinators, customerPaid } from "./helpers.js";

const PRICE = 500;
const OFF = 100;
const EARLY_CANCELS = 4;

await runScenario(async (scenario) => {
  const [known, fresh, merchant] = await setupPlayersWithProperties(scenario, 3, () => ({ max_daily_early_cancels: EARLY_CANCELS, max_pending_orders: 20, newcomer_work_bits: 4, newcomer_work_max_bits: 6 }));
  const all = [known, fresh, merchant];
  for (const p of [known, fresh]) await useTestCoordinators(p, ["dispatch"]);
  const sync = () => dhtSync(all, known.cells[0].cell_id[0]);
  const call = (p: typeof known, zome: string) => retryingCaller(p.cells[0], zome);

  // ===== A newcomers' code is for a first order here =====
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: PRICE, available: true }));
  const welcome = actionHash(
    await call(merchant, "catalog")<HcRecord>("create_promo_code", {
      catalog_ref: store, code: "WELCOME", requirement: "None", reward: { FlatOffSubtotal: OFF }, expires_at: null, auto_apply: false,
      limits: { first_order_only: true, per_customer: null, once_per: null, total: null },
    }),
  );
  await sync();
  const order = (p: typeof known, promo_code_ref: ActionHash | null = null) =>
    call(p, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: promo_code_ref ? PRICE - OFF : PRICE, promo_code_ref });
  const blocked = (p: typeof known) => call(p, "dispatch")<{ promo: ActionHash; blocked: unknown }[]>("my_promo_standing", store).then((list) => list[0].blocked);
  assert.equal(await retryUntil(() => blocked(known), (b) => b !== undefined), null, "open to a customer who's never ordered here");
  const theirs = actionHash(await retryUntilOk(() => order(known, welcome)));
  await sync();
  await customerPaid(merchant, theirs, all);
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: theirs }));
  assert.equal(await retryUntil(() => blocked(known), (b) => b === "FirstOrderOnly"), "FirstOrderOnly", "used, it's shown closed to them");
  await assert.rejects(order(known, welcome), /first order here/, "told plainly");
  // Past the app: the network refuses it too.
  const version = actionHash(await call(fresh, "catalog")<HcRecord>("get_catalog", store));
  const rawPickup = (p: typeof known, promo_code_ref: ActionHash | null) =>
    call(p, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: p.agentPubKey, merchant: merchant.agentPubKey, catalog_ref: store, catalog_version: version,
      lines: [{ item_ref: stew, priced_version: stew, quantity: 1, selections: [] }],
      order_total: promo_code_ref ? PRICE - OFF : PRICE, status: "Placed", requested_at: Date.now() * 1000, kitchen_note: null, promo_code_ref,
      loyalty_proof: [], rewards: null, cancellation: null, ready_by: null, customer_payment: null, sealed_customer_name: null,
    });
  await assert.rejects(rawPickup(known, welcome), /first order here/, "nor will the network take a second");
  console.log("[PASS] a newcomers' code goes only to a customer's first order here");

  // ===== One card, one first-order deal, kept on the network =====
  // The store's payment agent claims the deal for each card it holds; the
  // claim lives on the network, under a digest only the store can make.
  const dealOrder = async (n: number) => actionHash(await retryUntilOk(() => order(n === 0 ? known : fresh)));
  const [orderA, orderB] = [await dealOrder(0), await dealOrder(1)];
  await sync();
  const claim = (by: typeof known, fingerprint: string, on: Uint8Array) => call(by, "dispatch")<boolean>("claim_newcomer_card", { store, fingerprint, order: on });
  assert.equal(await claim(merchant, "fp_card_1", orderA), true, "a card takes the deal");
  assert.equal(await claim(merchant, "fp_card_1", orderA), true, "on the same order, again: still its");
  await sync();
  assert.equal(await claim(merchant, "fp_card_1", orderB), false, "the same card, another order: refused");
  assert.equal(await claim(merchant, "fp_card_2", orderB), true, "another card is welcome");
  await assert.rejects(claim(known, "fp_card_3", orderA), /Only the store's owner/, "and only the store keeps its deal");
  console.log("[PASS] a store's first-order deal is one per card, remembered by the network rather than a device");

  // ===== A store seeing cards tested asks newcomers for work =====
  assert.equal(await call(fresh, "dispatch")("work_needed", merchant.agentPubKey), null, "nothing asked of anyone before");
  const asked = await call(merchant, "dispatch")<{ busy: ActionHash; bits: number }>("record_busy", { level: 9, until: (Date.now() + 15 * 60_000) * 1000 });
  assert.equal(asked.bits, 6, "doubled as asked, but never past the network's most");
  await sync();
  const need = await call(fresh, "dispatch")<{ payee: Uint8Array; busy: ActionHash; bits: number } | null>("work_needed", merchant.agentPubKey);
  assert.ok(need && Buffer.from(need.busy).equals(Buffer.from(asked.busy)) && need.bits === 6, "a payer with no record is asked for the work");
  let nonce = 0;
  while ((await call(fresh, "dispatch")<number>("work_bits_for_testing", { payer: fresh.agentPubKey, payee: merchant.agentPubKey, proof: { busy: need.busy, nonce } })) < need.bits) nonce++;
  const worked = actionHash(await retryUntilOk(() => order(fresh)));
  await sync();
  await call(fresh, "dispatch")("offer_payment", { order: worked, leg: "Customer", payment: { token: "tok_test_4242", save: false, work: { busy: need.busy, nonce } }, resumes: null });
  await sync();
  type Due = { Authorize?: { order: Uint8Array; work: { busy: Uint8Array; bits: number } | null } };
  const due = await retryUntil(() => call(merchant, "dispatch")<Due[]>("payments_due", null), (d) => d.some((x) => x.Authorize && Buffer.from(x.Authorize.order).equals(Buffer.from(worked))), 30, 1000);
  const shown = due.find((x) => x.Authorize && Buffer.from(x.Authorize.order).equals(Buffer.from(worked)))!.Authorize!.work;
  assert.ok(shown && shown.bits >= 6 && Buffer.from(shown.busy).equals(Buffer.from(asked.busy)), "the store's agent sees the work done, for its record");
  // Someone else's busy record never stands for the store's.
  await call(fresh, "dispatch")("record_busy", { level: 0, until: (Date.now() + 15 * 60_000) * 1000 });
  await sync();
  const still = await call(known, "dispatch")<{ busy: ActionHash } | null>("work_needed", merchant.agentPubKey);
  assert.ok(still && Buffer.from(still.busy).equals(Buffer.from(asked.busy)), "only the store's own record asks work for it");
  console.log("[PASS] a store seeing cards tested asks payers with no record for work, which its agent can check");

  // An order a modified app writes raw, called off below.
  const raw = actionHash(await rawPickup(fresh, null));
  await sync();

  // ===== Calling off order after order before the store answers =====
  await call(fresh, "dispatch")("cancel_pickup_order", raw);
  // One kept out of the store's history, as a modified app hiding what it
  // means to call off: the store still counts it, from its active queue.
  const unlisted = actionHash(
    await call(fresh, "dispatch")<HcRecord>("create_unlisted_pickup_order_for_testing", {
      requester: fresh.agentPubKey, merchant: merchant.agentPubKey, catalog_ref: store, catalog_version: version,
      lines: [{ item_ref: stew, priced_version: stew, quantity: 1, selections: [] }],
      order_total: PRICE, status: "Placed", requested_at: Date.now() * 1000, kitchen_note: null, promo_code_ref: null,
      loyalty_proof: [], rewards: null, cancellation: null, ready_by: null, customer_payment: null, sealed_customer_name: null,
    }),
  );
  await call(fresh, "dispatch")("cancel_pickup_order", unlisted);
  const o = actionHash(await retryUntilOk(() => order(fresh)));
  await call(fresh, "dispatch")("cancel_pickup_order", o);
  const next = actionHash(await retryUntilOk(() => order(fresh)));
  await sync();
  await customerPaid(merchant, next, all);
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: next }), /called off several orders/);
  await retryUntilOk(() => call(merchant, "dispatch")("decline_pickup_order", { order_original_action: next, reason: "TooManyCancellations" }));
  // Only theirs: another customer at the same store is answered as ever.
  const someoneElses = actionHash(await retryUntilOk(() => order(known)));
  await sync();
  await customerPaid(merchant, someoneElses, all);
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: someoneElses }));
  console.log("[PASS] a customer who keeps calling off orders before the store answers has the next one declined, even those kept out of its history -- and nobody else does");

  // ===== And across every store, a daily allowance =====
  // Three called off so far; one more reaches the network's allowance here.
  const last = actionHash(await retryUntilOk(() => order(fresh)));
  await call(fresh, "dispatch")("cancel_pickup_order", last);
  await assert.rejects(order(fresh), /called off a lot of orders today/, "told plainly");
  const rawOrder = () =>
    call(fresh, "dispatch")("create_raw_pickup_order_for_testing", {
      requester: fresh.agentPubKey, merchant: merchant.agentPubKey, catalog_ref: store, catalog_version: version,
      lines: [{ item_ref: stew, priced_version: stew, quantity: 1, selections: [] }],
      order_total: PRICE, status: "Placed", requested_at: Date.now() * 1000, kitchen_note: null, promo_code_ref: null,
      loyalty_proof: [], rewards: null, cancellation: null, ready_by: null, customer_payment: null, sealed_customer_name: null,
    });
  await assert.rejects(rawOrder(), /as many orders today/, "and the network refuses it too");
  console.log("[PASS] a customer who's called off the network's daily allowance of orders, anywhere, orders again tomorrow");
});
