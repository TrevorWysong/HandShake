import assert from "node:assert/strict";
import { test } from "node:test";
import { customerRecordLines, storeRecordLines } from "../src/lib/reputation/recordLines.ts";

const zero = { completed_count: 0, cancelled_by_them_count: 0, dispute_raised_count: 0, dispute_resolved_against_count: 0, dropped_count: 0, late_count: 0, lapsed_count: 0, check_in_refused_count: 0, no_show_count: 0, total_collateral_forfeited: 0, bad_faith_stores: 0, faulted_count: 0 };
// The key, with its count: what each line says, without the translations.
const t = (key: string, vars?: Record<string, string | number>) => `${key}:${vars?.count}`;

test("a clean record has no lines -- completions aren't marks", () => {
  assert.deepEqual(customerRecordLines({ ...zero, completed_count: 40 }, t as never), []);
  assert.deepEqual(storeRecordLines({ ...zero, completed_count: 40 }, t as never), []);
});

test("a customer's lines: contested, no-shows, called off -- only those there are", () => {
  assert.deepEqual(customerRecordLines({ ...zero, no_show_count: 1, cancelled_by_them_count: 2 }, t as never), ["history.noShows:1", "history.cancelled:2"]);
  assert.deepEqual(customerRecordLines({ ...zero, dispute_resolved_against_count: 3, late_count: 9 }, t as never), ["history.contested:3"], "a store's marks never show on a customer");
});

test("a store's lines: drivers kept waiting, check-in reports, called off", () => {
  assert.deepEqual(storeRecordLines({ ...zero, late_count: 3, check_in_refused_count: 1, no_show_count: 5 }, t as never), ["store.late:3", "store.reports:1"], "a customer's marks never show on a store");
});
