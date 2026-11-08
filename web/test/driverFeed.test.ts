import assert from "node:assert/strict";
import { test } from "node:test";
import { feedRead, resetFeed, useDriverFeed } from "../src/store/driverFeed.ts";
import type { OrderRow } from "../src/lib/driving/deliveryRows.ts";

const row = (n: number) => ({ hash: new Uint8Array([n]) }) as OrderRow;

test("the first read after going online is what's there, not news", () => {
  resetFeed("dana");
  assert.equal(feedRead("dana", "dhvn", [row(1), row(2)], false), 0);
  assert.equal(useDriverFeed.getState().unseen, 0);
  assert.equal(useDriverFeed.getState().offered?.length, 2);
});

test("an order first offered after that is new, once", () => {
  resetFeed("dana");
  feedRead("dana", "dhvn", [row(1)], false);
  assert.equal(feedRead("dana", "dhvn", [row(1), row(2)], false), 1);
  assert.equal(feedRead("dana", "dhvn", [row(1), row(2)], false), 0, "not twice");
  assert.equal(feedRead("dana", "dhvn", [row(2), row(3)], false), 1);
  assert.equal(useDriverFeed.getState().unseen, 2, "both came while they looked elsewhere");
});

test("looking at the dashboard clears what's unseen, and still says what's new", () => {
  resetFeed("dana");
  feedRead("dana", "dhvn", [], false);
  feedRead("dana", "dhvn", [row(1)], false);
  assert.equal(feedRead("dana", "dhvn", [row(1), row(2)], true), 1);
  assert.equal(useDriverFeed.getState().unseen, 0);
});

test("a read for someone who's gone offline, or another driver, is dropped", () => {
  resetFeed(null);
  assert.equal(feedRead("dana", "dhvn", [row(1)], false), 0);
  assert.equal(useDriverFeed.getState().offered, undefined);
  resetFeed("sam");
  assert.equal(feedRead("dana", "dhvn", [row(1)], false), 0);
  assert.equal(useDriverFeed.getState().offered, undefined);
});
