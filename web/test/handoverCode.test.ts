// The digits a driver reads out at the counter, in place of their pickup QR
// code: the same six for the same leg, and from its hash alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickupDigits } from "../src/lib/orders/handoverCode.ts";

const leg = (fill: number) => Uint8Array.from([0x84, 0x29, 0x24, ...Array(32).fill(fill), 0, 0, 0, 0]);

test("a pickup leg reads out as six digits, the same each time", () => {
  assert.match(pickupDigits(leg(7)), /^\d{6}$/);
  assert.equal(pickupDigits(leg(7)), pickupDigits(leg(7)));
});

test("different legs read out differently, and leading zeros are kept", () => {
  assert.notEqual(pickupDigits(leg(7)), pickupDigits(leg(8)));
  assert.equal(pickupDigits(leg(0)), "000000");
});
