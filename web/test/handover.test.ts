// The old phone taking its account back: only the network's word that the
// new phone has written as the account is final. "Not yet" -- the network
// hasn't caught up -- leaves it to try again, and a later try goes through.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TakeBackRefused, takeAccountBack, takeBackRefusal } from "../src/lib/account/handover";

const NOT_YET = new Error("Guest(\"The network hasn't caught up with this account yet. Keep HandShake open and online, then try again in a moment.\")");
const TOO_LATE = new Error("Guest(\"Your new phone has started using this account, so this device can't take it back. Remove it from here: the account carries on on the new phone.\")");

test("not yet, then taken back: the first try is a retry, never 'too late', and the next goes through", async () => {
  let stays = 0;
  const answers = [NOT_YET, null];
  const runtime = {
    stay: async () => {
      stays++;
      const answer = answers.shift();
      if (answer) throw answer;
    },
  };
  await assert.rejects(takeAccountBack(runtime), (err: unknown) => err instanceof TakeBackRefused && err.refusal === "notYet");
  await takeAccountBack(runtime);
  assert.equal(stays, 2, "asked again, and taken back");
});

test("refused for good only once the new phone has written", async () => {
  await assert.rejects(takeAccountBack({ stay: async () => Promise.reject(TOO_LATE) }), (err: unknown) => err instanceof TakeBackRefused && err.refusal === "tooLate");
  assert.equal(takeBackRefusal(TOO_LATE), "tooLate");
  assert.equal(takeBackRefusal(NOT_YET), "notYet");
  assert.equal(takeBackRefusal(new Error("conductor went away")), "notYet", "anything else is tried again");
});
