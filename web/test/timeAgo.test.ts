import assert from "node:assert/strict";
import { test } from "node:test";
import { timeAgo } from "../src/lib/ui/format.ts";

test("how long ago is read against the time given, not the clock", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const micros = (msAgo: number) => (now.getTime() - msAgo) * 1000;
  assert.equal(timeAgo(micros(30_000), now), "just now");
  assert.match(timeAgo(micros(5 * 60_000), now), /5/);
  assert.match(timeAgo(micros(3 * 3_600_000), now), /3/);
  assert.equal(timeAgo(micros(-60_000), now), "just now", "a timestamp ahead of us reads as now");
});
