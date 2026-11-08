import assert from "node:assert/strict";
import { test } from "node:test";
import { retrying } from "../src/lib/network/retry.ts";

/// A step that fails `times` times, then returns how many tries it took.
function failing(times: number, error = new Error("not here yet")) {
  let tries = 0;
  return { work: async () => (++tries <= times ? Promise.reject(error) : tries), tries: () => tries };
}

test("a step is tried again after each delay until it succeeds", async () => {
  const step = failing(2);
  assert.equal(await retrying(step.work, [0, 0, 0]), 3);
});

test("past its last delay, the last failure is thrown", async () => {
  const step = failing(5);
  await assert.rejects(retrying(step.work, [0, 0]), /not here yet/);
  assert.equal(step.tries(), 3);
});

test("a failure that isn't retryable is thrown at once", async () => {
  const step = failing(5, new Error("refused"));
  await assert.rejects(retrying(step.work, [0, 0], (err) => !(err instanceof Error && err.message === "refused")), /refused/);
  assert.equal(step.tries(), 1);
});
