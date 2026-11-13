import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryNote, detailsRoom } from "../src/lib/orders/deliveryReport.ts";
import { MAX_NOTE_CHARS } from "../src/holochain/types.ts";

test("a delivery report's note: the reasons, then what was written", () => {
  assert.equal(deliveryNote(["Late", "Cold"], "  40 minutes  "), "Late, Cold — 40 minutes");
  assert.equal(deliveryNote(["Late"], ""), "Late");
  assert.equal(deliveryNote([], "Spilled everywhere"), "Spilled everywhere");
});

test("never past the network's note limit", () => {
  const reasons = ["Late", "Cold"];
  const room = detailsRoom(reasons);
  assert.equal(deliveryNote(reasons, "x".repeat(room)).length, MAX_NOTE_CHARS);
  assert.equal(deliveryNote(reasons, "x".repeat(room + 50)).length, MAX_NOTE_CHARS);
  assert.equal(detailsRoom([]), MAX_NOTE_CHARS);
});
