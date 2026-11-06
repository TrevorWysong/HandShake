import assert from "node:assert/strict";
import { test } from "node:test";
import { repricedLine, saleOff, saleProblem, saleRunning, soldRow } from "../src/lib/storefront/sales.ts";
import type { ItemSale, MenuItem } from "../src/holochain/types.ts";
import type { ItemRow } from "../src/lib/storefront/menu.ts";

const sale = (over: Partial<ItemSale> = {}): ItemSale => ({ price_cents: 700, label: "", starts_at: null, ends_at: null, weekly: [], ...over });
const UTC = { time_zone: "UTC" };
// A Wednesday, 16:00 UTC.
const AT = new Date("2026-11-04T16:00:00Z");
const micros = (iso: string) => new Date(iso).getTime() * 1000;
const row = (item: Partial<MenuItem>) => ({ hash: new Uint8Array(39), version: new Uint8Array(39), item: { price_cents: 1000, ...item } as MenuItem }) as ItemRow;

test("a sale with no schedule runs all the time", () => assert.equal(saleRunning(sale(), UTC, AT), true));

test("dates bound it: from its start, up to its end", () => {
  assert.equal(saleRunning(sale({ starts_at: micros("2026-11-04T17:00:00Z") }), UTC, AT), false);
  assert.equal(saleRunning(sale({ starts_at: micros("2026-11-04T16:00:00Z") }), UTC, AT), true);
  assert.equal(saleRunning(sale({ ends_at: micros("2026-11-04T16:00:00Z") }), UTC, AT), false);
});

test("a week's times read in the store's own time zone", () => {
  const happyHour = sale({ weekly: [{ weekday: 3, opens: 15 * 60, closes: 18 * 60 }] });
  assert.equal(saleRunning(happyHour, UTC, AT), true);
  assert.equal(saleRunning(happyHour, { time_zone: "Asia/Tokyo" }, AT), false, "it's 1am Thursday there");
  assert.equal(saleRunning(sale({ weekly: [{ weekday: 2, opens: 15 * 60, closes: 18 * 60 }] }), UTC, AT), false, "another day");
});

test("a line sells at the sale's price while it's running, and says what it's down from", () => {
  const onSale = soldRow(row({ sale: sale() }), UTC, AT);
  assert.equal(onSale.item.price_cents, 700);
  assert.equal(onSale.fullPriceCents, 1000);
  const off = soldRow(row({ sale: sale({ ends_at: micros("2026-01-01T00:00:00Z") }) }), UTC, AT);
  assert.equal(off.item.price_cents, 1000);
  assert.equal(off.fullPriceCents, undefined);
});

test("a cart line takes today's price, and keeps what its choices add", () => {
  const line = { itemRef: new Uint8Array(39), basePriceCents: 1000, priceCents: 1250 };
  assert.deepEqual(repricedLine(line, 700), { ...line, basePriceCents: 700, priceCents: 950 });
  assert.equal(repricedLine(line, 1000), line, "unchanged, it's the same line");
});

test("what the network would refuse, the editor says first", () => {
  assert.equal(saleProblem(sale(), 1000), null);
  assert.notEqual(saleProblem(sale({ price_cents: 1000 }), 1000), null);
  assert.notEqual(saleProblem(sale({ price_cents: 0 }), 1000), null);
  assert.notEqual(saleProblem(sale({ starts_at: 2, ends_at: 1 }), 1000), null);
});

test("what comes off reads as a percent, unless it's too small for one", () => {
  assert.match(saleOff(1000, 700), /30/);
  assert.match(saleOff(10000, 9990), /0\.10/);
});
