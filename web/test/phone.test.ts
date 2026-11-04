import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePhone } from "../src/lib/phone.ts";

test("a number as it's typed at home is kept in its international form", () => {
  assert.equal(normalizePhone("(213) 373-4253", "US"), "+1 213 373 4253");
  assert.equal(normalizePhone("020 7946 0958", "GB"), "+44 20 7946 0958");
  assert.equal(normalizePhone("0151 23456789", "DE"), "+49 1512 3456789");
  assert.equal(normalizePhone("55 1234 5678", "MX"), "+52 55 1234 5678");
});

test("a number with its country code reads the same from any region", () => {
  assert.equal(normalizePhone("+44 20 7946 0958", "US"), "+44 20 7946 0958");
  assert.equal(normalizePhone("+81 3-1234-5678", undefined), "+81 3 1234 5678");
});

test("none is fine; a partial number, or anything else, isn't a number", () => {
  assert.equal(normalizePhone("   ", "US"), "");
  for (const typed of ["555-0123", "12", "call me", "+1 000 000 0000", "javascript:alert(1)"]) {
    assert.equal(normalizePhone(typed, "US"), null, typed);
  }
});
