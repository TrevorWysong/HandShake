import { test } from "node:test";
import assert from "node:assert/strict";
import { inTiers, nearestFirst, pageByPage } from "../src/lib/storefront/nearby.ts";
import { encodeGeohash } from "../src/lib/places/geohash.ts";

const listing = (n: number, lat: number, lon: number) => ({ catalog: new Uint8Array([n]), geohash: encodeGeohash(lat, lon, 8) });

test("stores near someone rank nearest first, from their listings alone", () => {
  const here = { lat: 27.7676, lon: -82.6403 };
  const ranked = nearestFirst([listing(1, 27.78, -82.64), listing(2, 27.768, -82.6405), listing(3, 27.77, -82.65)], here);
  assert.deepEqual(ranked.map((l) => l.hash[0]), [2, 3, 1]);
  assert.equal(ranked[0].hex, "02");
});

test("a listing whose position can't be read is left out, never thrown on", () => {
  const here = { lat: 0, lon: 0 };
  assert.deepEqual(nearestFirst([{ catalog: new Uint8Array([9]), geohash: "not-a-geohash!" }, listing(1, 0.01, 0.01)], here).map((l) => l.hash[0]), [1]);
});

test("the wider area's stores come after those around someone, never among them", () => {
  const here = { lat: 27.7676, lon: -82.6403 };
  const near = nearestFirst([listing(1, 27.768, -82.6405), listing(2, 27.78, -82.64)], here);
  // The wider read finds the near ones again, and one nearer than store 2 that sits outside the cells around here.
  const wider = nearestFirst([listing(2, 27.78, -82.64), listing(3, 27.77, -82.66), listing(1, 27.768, -82.6405), listing(4, 27.9, -82.7)], here);
  assert.deepEqual(inTiers(near, undefined).map((l) => l.hash[0]), [1, 2]);
  assert.deepEqual(inTiers(near, wider).map((l) => l.hash[0]), [1, 2, 3, 4], "shown stores keep their places; each store once");
});

test("pages are ordered each on its own, so a new page never reshuffles the last", () => {
  const descending = (page: number[]) => [...page].sort((a, b) => b - a);
  const first = pageByPage([1, 2, 3], 3, descending);
  const both = pageByPage([1, 2, 3, 4, 5, 6], 3, descending);
  assert.deepEqual(first, [3, 2, 1]);
  assert.deepEqual(both.slice(0, 3), first, "the first page stays as it was");
  assert.deepEqual(both, [3, 2, 1, 6, 5, 4]);
});
