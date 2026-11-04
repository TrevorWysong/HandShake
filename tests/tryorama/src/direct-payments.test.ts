// Paying for a delivery directly (dispatch_types::direct): the customer's
// card held on the store's account, the driver's collateral on the store's,
// the driver's pay on the store's card -- each step waiting on its payment,
// each payee settling with exactly what it's owed, and every forged record
// refused. The payee agents are played by `payeeAgent`, as the real one
// (payments/) plays them on a processor.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import {
  TEST_CARD,
  acceptOrder,
  actionHash,
  commitAndCook,
  handOff,
  heldBy,
  netOn,
  offerCard,
  paymentsOn,
  pickUp,
  retryUntilOk,
  retryingCaller,
  settleAll,
  ST_PETE,
  testApp,
  useTestCoordinators,
} from "./helpers.js";

const FOOD = 600;
const CAP = 800;
const TIP = 200;
const FEE = 600;

await runScenario(async (scenario) => {
  const [customer, store, driver, stranger] = await scenario.addPlayersWithApps([testApp, testApp, testApp, testApp]);
  const all = [customer, store, driver, stranger];
  await scenario.shareAllAgents();
  for (const p of [store, driver, stranger]) await useTestCoordinators(p, ["dispatch"]);
  const sync = (from = customer) => dhtSync(all, from.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const raw = (p: typeof customer, record: unknown) => p.cells[0].callZome({ zome_name: "dispatch", fn_name: "create_raw_payment_record_for_testing", payload: record });

  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: Date.now() * 1000 });
  const shop = actionHash(await call(store, "catalog")<HcRecord>("publish_catalog", { business_name: "Cara's", location: ST_PETE }));
  const empanada = actionHash(await call(store, "catalog")<HcRecord>("add_menu_item", { catalog_ref: shop, name: "Empanada", price_cents: FOOD, available: true }));
  await sync(store);

  // ===== The customer's card, held on the store's account =====
  const order = actionHash(
    await call(customer, "dispatch")<HcRecord>("request_delivery", {
      merchant: store.agentPubKey, catalog_ref: shop, items: [{ item_ref: empanada, quantity: 1 }], order_total: FOOD,
      dropoff: ST_PETE, max_delivery_fee: CAP, tip_cents: TIP, payment: { token: TEST_CARD, save: true },
    }),
  );
  await sync();
  const { Waiting: waiting } = await call(customer, "dispatch")<{ Waiting: { offer: Uint8Array } }>("my_payment", { order, leg: "Customer" });
  await assert.rejects(call(stranger, "dispatch")("offer_payment", { order, leg: "Customer", payment: { token: TEST_CARD, save: false } }), /Only whoever pays/, "only the order's customer offers its card");
  await assert.rejects(raw(stranger, { Hold: { offer: waiting.offer, amount: FOOD + 400 + TIP, reference: "pi_forged" } }), /held by its payee/, "nobody else holds the store's payment");
  await assert.rejects(raw(store, { Hold: { offer: waiting.offer, amount: 1, reference: "pi_short" } }), /exactly what its leg needs/, "a hold is for exactly what the leg needs");
  const due = await call(store, "dispatch")<{ Authorize?: { amount: number } }[]>("payments_due", null);
  assert.equal(due.find((d) => d.Authorize)?.Authorize?.amount, FOOD + CAP / 2 + TIP, "the store's agent authorizes the food, half the capped fee, and the tip");
  await assert.rejects(call(store, "dispatch")("accept_delivery_order", { order_original_action: order }), /isn't held yet/, "no store accepts an order it isn't paid for");
  await acceptOrder(store, order, all);
  console.log("[PASS] the customer's card is held on the store's account before it accepts, for exactly what the order needs");

  // The card they kept with the store is theirs to use again -- nobody
  // else's, and only with that store.
  assert.equal(await call(customer, "dispatch")("has_saved_card", store.agentPubKey), true, "the customer is offered the card they saved with the store");
  assert.equal(await call(stranger, "dispatch")("has_saved_card", store.agentPubKey), false, "another account isn't");
  assert.equal(await call(customer, "dispatch")("has_saved_card", driver.agentPubKey), false, "nor is it saved with anyone else");
  console.log("[PASS] a saved card is offered only to the account that saved it, with the store it's saved with");

  // ===== The driver's collateral, held on the store's account =====
  const bid = actionHash(await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: FEE })));
  await sync(driver);
  await retryUntilOk(() => call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: bid }));
  await sync();
  await assert.rejects(driver.cells[0].callZome({ zome_name: "dispatch", fn_name: "commit_to_order", payload: order }), /hasn't held your collateral/, "a driver commits only once the store holds their collateral");
  await offerCard(driver, order, { Collateral: { bid } });
  await sync(driver);
  await heldBy(store, order, { Collateral: { bid } }, all);
  await assert.rejects(driver.cells[0].callZome({ zome_name: "dispatch", fn_name: "commit_to_order", payload: order }), /hasn't paid you/, "nor until their pay is held, from the store's card");
  await offerCard(store, order, { DriverPay: { bid } }, true);
  await sync(store);
  await heldBy(driver, order, { DriverPay: { bid } }, all);
  await commitAndCook(driver, store, order, all);
  console.log("[PASS] a driver sets off once the store holds their collateral and they hold their pay");

  // ===== Picked up and delivered =====
  await handOff(driver, store, order, "MerchantHandoff", all);
  await pickUp(driver, order);
  await sync(driver);

  // ===== Delivered and settled: everyone exactly as owed =====
  await handOff(driver, customer, order, "CustomerHandoff", all);
  await retryUntilOk(() => call(customer, "dispatch")("complete_delivery", { order_original_action: order }));
  await sync();
  await settleAll(all, order);
  const payments = await paymentsOn(customer, order);
  assert.equal(payments.length, 3, "the customer's payment, the driver's collateral, and the driver's pay");
  assert.ok(payments.every((p) => p.charged !== null), "each settled");
  assert.equal(await netOn(customer, order), -(FOOD + FEE / 2 + TIP), "the customer: the food, their half of the fee, the tip");
  assert.equal(await netOn(driver, order), FEE + TIP, "the driver: the whole fee and the tip; their collateral released");
  assert.equal(await netOn(store, order), FOOD - FEE / 2, "the store: the food, less its half of the fee");
  console.log("[PASS] each payee captures exactly what it's owed, and releases the rest");

  // ===== Forged settlements are refused =====
  const theirs = payments.find((p) => typeof p.leg === "object" && "Collateral" in p.leg);
  assert.equal(theirs?.charged, 0, "a delivered driver's collateral is released, not captured");
  console.log("[PASS] a delivered driver's collateral costs them nothing");
  await assert.rejects(call(stranger, "dispatch")("record_settlement", { hold: order, claims: [] }), /./, "nobody settles a hold that isn't theirs");
  console.log("[PASS] direct payments settle every party exactly, and no one can write another's records");
});
