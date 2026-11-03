// A promo code's limits (catalog_types::PromoLimits): new customers only,
// so many uses per customer, once a day -- held by validation against the
// customer's own chain, so an order written past the app is refused too --
// and a total across customers, which the store holds orders to as it
// accepts them. An order that came to nothing before the store took it on --
// cancelled first, or declined -- uses none of them up. Forgeries are written
// raw (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, bytesEqual, retryUntil, retryUntilOk, retryingCaller, testApp, useTestCoordinators, customerPaid } from "./helpers.js";

const PRICE = 1000;
const OFF = 100;

interface Standing {
  promo: ActionHash;
  uses: number;
  remaining: number | null;
  blocked: string | { ThisPeriod: string } | null;
}

await runScenario(async (scenario) => {
  const [merchant, ana, ben, cal, dee] = await scenario.addPlayersWithApps([testApp, testApp, testApp, testApp, testApp]);
  const all = [merchant, ana, ben, cal, dee];
  await scenario.shareAllAgents();
  for (const p of [ana, ben]) await useTestCoordinators(p, ["dispatch"]);
  const sync = () => dhtSync(all, merchant.cells[0].cell_id[0]);
  const call = (p: typeof ana, zome: string) => retryingCaller(p.cells[0], zome);

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: PRICE, available: true }));
  const promo = async (code: string, limits: Record<string, unknown>) =>
    actionHash(
      await call(merchant, "catalog")<HcRecord>("create_promo_code", {
        catalog_ref: store,
        code,
        requirement: "None",
        reward: { FlatOffSubtotal: OFF },
        expires_at: null,
        auto_apply: false,
        limits: { first_order_only: false, per_customer: null, once_per: null, total: null, ...limits },
      }),
    );
  await assert.rejects(promo("ZERO", { per_customer: 0 }), /per customer are between 1/, "limits are checked");
  const welcome = await promo("WELCOME", { first_order_only: true });
  const once = await promo("ONCE", { per_customer: 1 });
  const daily = await promo("DAILY", { once_per: "Day" });
  const capped = await promo("CAPPED", { total: 2 });
  await sync();

  const order = (p: typeof ana, promo_code_ref: ActionHash) =>
    call(p, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: PRICE - OFF, promo_code_ref });
  /// The same order, written past the app's checks.
  const raw = async (p: typeof ana, promo_code_ref: ActionHash) => {
    const version = actionHash(await call(p, "catalog")<HcRecord>("get_catalog", store));
    return call(p, "dispatch")("create_raw_pickup_order_for_testing", {
      requester: p.agentPubKey, merchant: merchant.agentPubKey, catalog_ref: store, catalog_version: version,
      lines: [{ item_ref: stew, priced_version: stew, quantity: 1, selections: [] }],
      order_total: PRICE - OFF, status: "Placed", requested_at: Date.now() * 1000, kitchen_note: null, promo_code_ref,
      loyalty_proof: [], cancellation: null, ready_by: null, customer_payment: null, sealed_customer_name: null,
    });
  };
  const standing = (p: typeof ana, which: ActionHash) => call(p, "dispatch")<Standing[]>("my_promo_standing", store).then((list) => list.find((s) => bytesEqual(s.promo, which))!);

  // ===== New customers only =====
  await retryUntilOk(() => order(ana, welcome));
  assert.equal((await standing(ana, welcome)).blocked, "FirstOrderOnly", "shown before they try again");
  await assert.rejects(order(ana, welcome), /first order here/);
  await assert.rejects(raw(ana, welcome), /first order here/, "the network refuses it too");
  console.log("[PASS] a new-customers code works on a customer's first order here, and only that");

  // ===== Once per customer =====
  const used = actionHash(await retryUntilOk(() => order(ana, once)));
  assert.equal((await standing(ana, once)).uses, 1);
  await assert.rejects(order(ana, once), /as many times as it allows/);
  await assert.rejects(raw(ana, once), /as many times as it allows/, "the network refuses it too");
  // Still used once the store takes it on and the customer's app confirms
  // so -- a confirmation isn't a decline, though the two look alike.
  await sync();
  await customerPaid(merchant, used, all);
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: used }));
  await sync();
  const confirmation = await retryUntil(() => call(ana, "dispatch")<ActionHash | null>("confirm_what_i_saw", used), (hash) => hash !== null);
  assert.ok(confirmation, "the customer's app confirms the store started");
  const confirmed = await standing(ana, once);
  assert.deepEqual([confirmed.uses, confirmed.blocked], [1, "UsedUp"], "confirmed, still used");
  console.log("[PASS] a once-per-customer code works once, and stays used once the store takes the order on");

  // ===== Once a day =====
  await retryUntilOk(() => order(ben, daily));
  assert.deepEqual((await standing(ben, daily)).blocked, { ThisPeriod: "Day" });
  await assert.rejects(order(ben, daily), /this time around/);
  await assert.rejects(raw(ben, daily), /this period/, "the network refuses it too");
  console.log("[PASS] a once-a-day code works once a day, in the store's time");

  // ===== An order that came to nothing gives its promo back =====
  const declined = actionHash(await retryUntilOk(() => order(dee, welcome)));
  await sync();
  await retryUntilOk(() => call(merchant, "dispatch")("decline_pickup_order", { order_original_action: declined, reason: "TooBusy" }));
  await sync();
  // The customer's app notes the decline by itself; or here.
  await retryUntil(() => call(dee, "dispatch")("confirm_what_i_saw", declined).then(() => standing(dee, welcome)), (s) => s.blocked === null);
  await retryUntilOk(() => order(dee, welcome));
  console.log("[PASS] a store declining an order gives back its new-customers code: the next order is still their first");

  const cancelled = actionHash(await retryUntilOk(() => order(dee, once)));
  await call(dee, "dispatch")("cancel_pickup_order", cancelled);
  const after = await standing(dee, once);
  assert.deepEqual([after.uses, after.blocked], [0, null], "cancelled before the store took it on: not a use");
  await retryUntilOk(() => order(dee, once));
  console.log("[PASS] an order cancelled before the store accepted it gives back its once-only code");

  // ===== A total across customers, held by the store =====
  const orders = [];
  for (const p of [ana, ben, cal]) orders.push(actionHash(await retryUntilOk(() => order(p, capped))));
  await sync();
  for (const o of orders.slice(0, 2)) {
    await customerPaid(merchant, o, all);
    await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: o }));
  }
  await customerPaid(merchant, orders[2], all);
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: orders[2] }), /used as many times as it allows/, "the third isn't accepted");
  await sync();
  const left = await retryUntil(() => standing(cal, capped), (s) => s.remaining === 0);
  assert.equal(left.blocked, "SoldOut", "and customers see it's all claimed");
  console.log("[PASS] a code with a total stops at it: the store accepts no more, and customers see it's claimed");
});
