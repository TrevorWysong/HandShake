// A sign-up whose vehicle doesn't save, tried again, carries on from the
// vehicle: one account, one profile, its address saved once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { completeSignup, type SignupStep } from "../src/lib/account/signup";

test("a driver's vehicle fails once: the retry carries on from it, never making a second account", async () => {
  const made = { account: 0, address: 0, vehicle: 0 };
  let vehicleFails = 1;
  const steps: SignupStep[] = [
    { name: "account", run: async () => void made.account++ },
    { name: "address", run: async () => void made.address++ },
    {
      name: "vehicle",
      run: async () => {
        made.vehicle++;
        if (vehicleFails-- > 0) throw new Error("register_provider_credential failed");
      },
    },
  ];
  const done = new Set<SignupStep["name"]>();
  await assert.rejects(completeSignup(steps, done), /register_provider_credential failed/);
  assert.deepEqual([...done], ["account", "address"], "what went through stays done");
  await completeSignup(steps, done);
  assert.deepEqual(made, { account: 1, address: 1, vehicle: 2 }, "one account, one address; the vehicle tried again");
});
