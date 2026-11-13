import assert from "node:assert/strict";
import { test } from "node:test";
import { BAD_FAITH_LABEL, BAD_FAITH_REASONS, FAULT_LABEL, FAULT_REASONS, findingLabel, shownToStores } from "../src/lib/reputation/findings.ts";

test("one store's view of a customer never follows them: shown only from enough stores", () => {
  assert.equal(shownToStores(1, 2), false);
  assert.equal(shownToStores(2, 2), true);
  assert.equal(shownToStores(0, 0), false, "never shown with no store at all, whatever the setting");
  assert.equal(shownToStores(1, 0), true);
});

test("every reason has its words, and a finding reads as its reason", () => {
  for (const reason of BAD_FAITH_REASONS) assert.ok(BAD_FAITH_LABEL[reason]);
  for (const reason of FAULT_REASONS) assert.ok(FAULT_LABEL[reason]);
  assert.equal(findingLabel({ BadFaith: "RepeatedClaim" }), "finding.badFaith.RepeatedClaim");
  assert.equal(findingLabel({ DriverAtFault: "Late" }), "finding.fault.Late");
});
