// Proves recovering an account whose key was lost, onto a new key: by the
// recovery phrase's signature, or by enough guardians -- each checked
// against the account's own latest plan. (Moving to a new phone keeps the
// key: device-move.test.ts.) Forgeries are written raw (test-utils), as a
// modified client would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import { phraseKey, phraseMessage, retryUntil, setupPlayersWithProperties, useTestCoordinators, retryingCaller } from "./helpers.js";

interface PlanView {
  plan: Uint8Array;
  account: Uint8Array;
  phrase_key: Uint8Array | null;
  guardians: Uint8Array[];
  threshold: number;
}
interface SuccessionView {
  succession: Uint8Array;
  predecessor: Uint8Array;
  successor: Uint8Array;
  kind: "Phrase" | "Guardians";
}

const same = (a: Uint8Array | null | undefined, b: Uint8Array) => !!a && Buffer.from(a).equals(Buffer.from(b));

await runScenario(async (scenario) => {
  const [frank, alice, bob, carol, dana, erin, hank] = await setupPlayersWithProperties(scenario, 7, () => ({}));
  const all = [frank, alice, bob, carol, dana, erin, hank];
  for (const p of all) await useTestCoordinators(p, ["account"]);
  const sync = () => dhtSync(all, alice.cells[0].cell_id[0]);
  const account = (p: typeof alice) => retryingCaller(p.cells[0], "account");

  // ===== A plan is the account's own, and sound =====
  const rawPlan = (p: typeof alice, plan: unknown) => account(p)("create_raw_plan_for_testing", plan);
  const guardians = [bob.agentPubKey, carol.agentPubKey, frank.agentPubKey];
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians: [dana.agentPubKey], threshold: 1 }), /a guardian is someone else/);
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians: [bob.agentPubKey, bob.agentPubKey], threshold: 1 }), /each guardian once/);
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians, threshold: 4 }), /more than half its guardians, and at most all/);
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians, threshold: 0 }), /more than half its guardians/);
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians, threshold: 1 }), /more than half its guardians/, "one of three would let two others each recover it");
  await assert.rejects(rawPlan(dana, { phrase_key: null, guardians: [], threshold: 1 }), /needs no vouches/);
  await assert.rejects(rawPlan(dana, { phrase_key: dana.agentPubKey, guardians: [], threshold: 0 }), /its own, not the account's/);
  console.log("[PASS] a recovery plan names others, each once, and needs a majority of them");

  // ===== Recovery by phrase =====
  const phrase = phraseKey();
  const firstPlan = await account(dana)<PlanView>("set_recovery_plan", { phrase_key: phrase.key, guardians, threshold: 2 });
  await sync();
  const accounts = await retryUntil(() => account(erin)<PlanView[]>("accounts_for_phrase_key", phrase.key), (list) => list.length === 1);
  assert.ok(same(accounts[0].account, dana.agentPubKey), "the phrase finds the account it recovers");
  const head = await retryUntil(() => account(erin)<Uint8Array | null>("latest_action_of", dana.agentPubKey), (h) => !!h);
  const viaPhrase = (signature: Uint8Array, plan = firstPlan.plan, at = head!) => ({ predecessor: dana.agentPubKey, authority: { Phrase: { plan, head: at, signature } } });

  await assert.rejects(account(erin)("take_over", viaPhrase(phrase.sign(phraseMessage(dana.agentPubKey, hank.agentPubKey, head!)))), /recovery phrase's signature/, "a signature for another key");
  await assert.rejects(account(erin)("take_over", viaPhrase(phraseKey().sign(phraseMessage(dana.agentPubKey, erin.agentPubKey, head!)))), /recovery phrase's signature/, "another phrase's signature");
  const carolHead = await retryUntil(() => account(erin)<Uint8Array | null>("latest_action_of", carol.agentPubKey), (h) => !!h);
  await assert.rejects(account(erin)("take_over", viaPhrase(phrase.sign(phraseMessage(dana.agentPubKey, erin.agentPubKey, carolHead!)), firstPlan.plan, carolHead!)), /its own chain/, "where the account stood is on its chain");

  await account(erin)("take_over", viaPhrase(phrase.sign(phraseMessage(dana.agentPubKey, erin.agentPubKey, head!))));
  await assert.rejects(account(erin)("take_over", viaPhrase(phrase.sign(phraseMessage(dana.agentPubKey, erin.agentPubKey, head!)))), /already taken over/, "a key takes over one account");
  await assert.rejects(
    account(erin)("create_raw_succession_for_testing", { predecessor: carol.agentPubKey, authority: { Phrase: { plan: firstPlan.plan, head, signature: phrase.sign(phraseMessage(carol.agentPubKey, erin.agentPubKey, head!)) } } }),
    /one account/,
    "even forged",
  );
  await sync();
  const moved = await retryUntil(() => account(carol)<SuccessionView[]>("successions_of", dana.agentPubKey), (list) => list.length === 1);
  assert.ok(same(moved[0].successor, erin.agentPubKey) && moved[0].kind === "Phrase", "everyone sees Dana's account recovered onto Erin's key");
  const line = await account(carol)<Uint8Array[]>("lineage", erin.agentPubKey);
  assert.ok(line.length === 1 && same(line[0], dana.agentPubKey), "and Erin's key carries Dana's history");
  assert.ok(same(await account(carol)<Uint8Array | null>("successor_of", dana.agentPubKey), erin.agentPubKey), "the one key that carries it on");
  console.log("[PASS] the recovery phrase's signature, for this key and this account, recovers it");

  // ===== Recovery by guardians =====
  await assert.rejects(account(alice)("vouch", { account: dana.agentPubKey, successor: hank.agentPubKey }), /aren't one of this account's guardians/);
  await assert.rejects(account(alice)("create_raw_vouch_for_testing", { account: dana.agentPubKey, successor: hank.agentPubKey, plan: firstPlan.plan }), /only a guardian/, "nor forged");
  const wards = await retryUntil(() => account(bob)<PlanView[]>("my_wards", null), (list) => list.length === 1);
  assert.ok(same(wards[0].account, dana.agentPubKey), "a guardian sees who they guard");
  const bobVouch = await account(bob)<Uint8Array>("vouch", { account: dana.agentPubKey, successor: hank.agentPubKey });
  assert.deepEqual(await account(bob)("vouch", { account: dana.agentPubKey, successor: hank.agentPubKey }), bobVouch, "safe to repeat");
  await assert.rejects(account(bob)("vouch", { account: dana.agentPubKey, successor: carol.agentPubKey }), /already vouched for another key/);
  await assert.rejects(account(bob)("create_raw_vouch_for_testing", { account: dana.agentPubKey, successor: carol.agentPubKey, plan: firstPlan.plan }), /once for each account and plan/, "once, even forged");
  await sync();
  const viaGuardians = (vouches: Uint8Array[]) => ({ predecessor: dana.agentPubKey, authority: { Guardians: { plan: firstPlan.plan, head, vouches } } });
  await assert.rejects(account(hank)("take_over", viaGuardians([bobVouch])), /not enough guardians/, "one of two isn't enough");
  await assert.rejects(account(hank)("take_over", viaGuardians([bobVouch, bobVouch])), /counts once/, "nor the same one twice");
  const carolVouch = await account(carol)<Uint8Array>("vouch", { account: dana.agentPubKey, successor: hank.agentPubKey });
  await sync();
  const vouches = await retryUntil(() => account(hank)<unknown[]>("vouches_for_me", null), (list) => list.length === 2);
  assert.equal(vouches.length, 2);
  await account(hank)("take_over", viaGuardians([bobVouch, carolVouch]));
  console.log("[PASS] enough of an account's guardians, each once, recover it");

  // ===== Two keys that took over one account: neither carries it on =====
  // Validation can't see the whole network, so it can't refuse a second
  // recovery -- by guardians here, or a phrase signing for two keys. But a
  // contested account carries on with nobody.
  await sync();
  const contested = await retryUntil(() => account(alice)<SuccessionView[]>("successions_of", dana.agentPubKey), (list) => list.length === 2);
  assert.equal(contested.length, 2, "both recoveries are on record");
  assert.equal(await account(alice)<Uint8Array | null>("successor_of", dana.agentPubKey), null, "but neither key carries the account on");
  assert.deepEqual(await account(alice)<Uint8Array[]>("lineage", erin.agentPubKey), [], "nor Dana's history -- the first key's");
  assert.deepEqual(await account(alice)<Uint8Array[]>("lineage", hank.agentPubKey), [], "nor the second's");
  console.log("[PASS] an account recovered twice carries on with neither key");

  // ===== Only the account's latest plan counts =====
  const newPhrase = phraseKey();
  await account(dana)("set_recovery_plan", { phrase_key: newPhrase.key, guardians: [], threshold: 0 });
  await sync();
  const newHead = await retryUntil(() => account(carol)<Uint8Array | null>("latest_action_of", dana.agentPubKey), (h) => !!h && !same(h, head!));
  await assert.rejects(
    account(carol)("take_over", { predecessor: dana.agentPubKey, authority: { Phrase: { plan: firstPlan.plan, head: newHead, signature: phrase.sign(phraseMessage(dana.agentPubKey, carol.agentPubKey, newHead!)) } } }),
    /latest recovery plan/,
    "a phrase the account replaced recovers nothing",
  );
  assert.equal((await account(carol)<PlanView[]>("accounts_for_phrase_key", phrase.key)).length, 0, "nor finds it");
  // Validation can only check the plan was current where the recovery says
  // the account stood -- an old point, here, before the phrase was
  // replaced. It accepts that; nobody counts it.
  await account(carol)("take_over", { predecessor: dana.agentPubKey, authority: { Phrase: { plan: firstPlan.plan, head, signature: phrase.sign(phraseMessage(dana.agentPubKey, carol.agentPubKey, head!)) } } });
  await sync();
  assert.deepEqual(await account(alice)<SuccessionView[]>("successions_of", dana.agentPubKey), [], "every recovery that rested on the replaced plan is void");
  assert.deepEqual(await account(alice)<Uint8Array[]>("lineage", carol.agentPubKey), [], "and carries no history");
  console.log("[PASS] a replaced plan no longer counts");
});
