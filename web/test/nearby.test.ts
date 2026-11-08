import { test } from "node:test";
import assert from "node:assert/strict";
import { nearestFirst } from "../src/lib/storefront/nearby.ts";
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
