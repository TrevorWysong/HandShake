// Whether an account moved on is read before the app shows anything, and a
// read that fails is never taken for "it hasn't": tried again, and refused
// if it still can't be had -- so a key whose account moved on never
// briefly carries on as if it hadn't.
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountStanding } from "../src/lib/account/standing";

const successor = new Uint8Array([0x84, 0x20, 0x24, ...new Array(36).fill(5)]);

test("a succession read that fails once, then answers: the account moved on, never 'it hasn't'", async () => {
  let asked = 0;
  const standing = await accountStanding(
    {
      successions: async () => {
        if (asked++ === 0) throw new Error("conductor not ready");
        return [{ successor }];
      },
      chainClosed: async () => null,
    },
    [1, 1],
  );
  assert.deepEqual(standing, { movedTo: successor, movedToNewVersion: false });
  assert.equal(asked, 2);
});

test("a read that never answers stops the session: it never comes back as 'nothing moved'", async () => {
  await assert.rejects(accountStanding({ successions: async () => [], chainClosed: async () => Promise.reject(new Error("network unreachable")) }, [1, 1]), /network unreachable/);
  await assert.rejects(accountStanding({ successions: async () => Promise.reject(new Error("timed out")), chainClosed: async () => null }, [1]), /timed out/);
});

test("a closed chain is a move to the next network", async () => {
  assert.deepEqual(await accountStanding({ successions: async () => [], chainClosed: async () => ({ close: new Uint8Array(39) }) }, []), { movedTo: null, movedToNewVersion: true });
});
