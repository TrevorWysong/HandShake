// A device's setup: each part on its own, a failing one tried again, and
// what still can't be set up said so -- never silently missing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setUpParts } from "../src/store/deviceSetup";

test("a part that fails once is tried again and set up; one that keeps failing is reported; the others never wait on it", async () => {
  const tries = { dispatch: 0, attestation: 0, rewards: 0 };
  const incomplete = await setUpParts(["dispatch", "attestation", "rewards"], async (part) => {
    tries[part]++;
    if (part === "attestation" && tries.attestation === 1) throw new Error("grant write failed");
    if (part === "rewards") throw new Error("still failing");
  }, [1, 1]);
  assert.deepEqual(incomplete, ["rewards"], "only the one that kept failing is incomplete");
  assert.deepEqual(tries, { dispatch: 1, attestation: 2, rewards: 3 }, "tried again; the rest ran once");
});
