// A driver's earnings come from their payment history: fees, tips and late
// cover stores paid them -- never what they paid out, nor holds released --
// by week or month, with their forfeited collateral beside them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { earned, earningsByPeriod, earningsCsv, periodStart } from "../src/lib/driving/earnings";
import type { PaymentHistoryItem, Portion } from "../src/holochain/types";

const h = (n: number) => new Uint8Array(39).fill(n);
const me = h(1);
const store = h(2);
const at = (iso: string) => new Date(iso).getTime() * 1000;
let next = 100;
/// A store paying `me` for a delivery, part by part -- or, `charged: null`, still held.
const pay = (when: string, parts: [Portion, number][], charged: number | null = parts.reduce((sum, [, c]) => sum + c, 0)): PaymentHistoryItem => ({
  order: h(next++),
  hold: h(next++),
  leg: { DriverPay: { bid: h(next++) } },
  payer: store,
  payee: me,
  held: 5000,
  charged,
  parts: charged === null ? [] : parts.map(([portion, amount]) => ({ part: { purpose: { DriverPay: { bid: h(0) } }, portion }, amount })),
  at: at(when),
  store_name: "Mo's",
  delivery: true,
});
const collateral = (when: string, charged: number, payer = me): PaymentHistoryItem => ({ order: h(next++), hold: h(next++), leg: { Collateral: { bid: h(next++) } }, payer, payee: store, held: charged || 1500, charged, parts: [], at: at(when), store_name: "Mo's", delivery: true });

test("fees, tips and late cover by week; held, released and paid-out money isn't earnings", () => {
  const items = [
    pay("2026-10-05T12:00:00", [["Fee", 600], ["Tip", 200]]),
    pay("2026-10-07T18:00:00", [["Fee", 500], ["LateCover", 300]]),
    // Their collateral, released: not earnings, not forfeited.
    collateral("2026-10-07T19:00:00", 0),
    // Next week: a delivery, a forfeited collateral, one still held, one voided.
    pay("2026-10-14T10:00:00", [["Fee", 700]]),
    pay("2026-10-16T10:00:00", [["Fee", 600]]),
    collateral("2026-10-13T10:00:00", 900),
    pay("2026-10-16T11:00:00", [], null),
    pay("2026-10-16T12:00:00", [], 0),
    // Someone else's collateral the history happens to carry: not theirs to forfeit.
    collateral("2026-10-15T10:00:00", 800, h(9)),
  ];
  const [later, earlier] = earningsByPeriod(items, me, "week");
  assert.deepEqual([earlier.deliveries, earlier.fees, earlier.tips, earlier.lateCover, earned(earlier), earlier.forfeited], [2, 1100, 200, 300, 1600, 0]);
  assert.deepEqual([later.deliveries, later.fees, later.forfeited], [2, 1300, 900]);
  assert.equal(earlier.start, periodStart(new Date("2026-10-05T00:00:00").getTime(), "week"), "weeks start on Monday");

  const [month] = earningsByPeriod(items, me, "month");
  assert.equal(month.deliveries, 4);
  const csv = earningsCsv([earlier], "week", (c) => (c / 100).toFixed(2));
  assert.equal(csv.split("\n")[1], "2026-10-05,2,11.00,2.00,3.00,16.00,0.00");
});

test("a driver paying a store isn't earning", () => {
  const paidOut: PaymentHistoryItem = { ...pay("2026-10-05T12:00:00", [["Fee", 600]]), payer: me, payee: store };
  assert.deepEqual(earningsByPeriod([paidOut], me, "week"), []);
});
