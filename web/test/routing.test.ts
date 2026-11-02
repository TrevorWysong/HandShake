import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { legMinutes, minutesTo } from "../src/lib/driving/routing.ts";
import { useNetwork } from "../src/store/network.ts";
import type { NetworkTerms } from "../src/holochain/types.ts";

const A = { lat: 27.7676, lon: -82.6403 };
const B = { lat: 27.8126, lon: -82.6403 };
const C = { lat: 27.79, lon: -82.66 };
const realFetch = globalThis.fetch;
let asked: string[] = [];

function answer(body: unknown, status = 200) {
  asked = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  useNetwork.setState({ terms: null });
});

test("a trip's legs, timed by road for how the driver travels", async () => {
  answer({ code: "Ok", routes: [{ legs: [{ duration: 600 }, { duration: 900 }] }] });
  assert.deepEqual(await legMinutes("bike", [A, B, C]), [10, 15]);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].startsWith("https://routing.openstreetmap.de/routed-bike/route/v1/driving/-82.640300,27.767600;"), asked[0]);
});

test("a scooter rides the roads a car does", async () => {
  answer({ code: "Ok", routes: [{ legs: [{ duration: 60 }] }] });
  await legMinutes("scooter", [A, B]);
  assert.ok(asked[0].includes("/routed-car/"), asked[0]);
});

test("no route, a broken answer or a failed request is no estimate -- never a guess", async () => {
  answer({ code: "NoRoute" });
  assert.equal(await legMinutes("car", [A, B]), null);
  answer({ code: "Ok", routes: [{ legs: [{ duration: 60 }] }] });
  assert.equal(await legMinutes("car", [A, B, C]), null, "a leg missing");
  answer({ code: "Ok", routes: [{ legs: [{ duration: -5 }] }] });
  assert.equal(await legMinutes("car", [A, B]), null, "a negative time");
  answer({ code: "Ok", routes: [{ legs: [{ duration: "600" }] }] });
  assert.equal(await legMinutes("car", [A, B]), null, "not a number");
  answer({ code: "Ok", routes: [{ legs: [{ duration: 1e9 }] }] });
  assert.equal(await legMinutes("car", [A, B]), null, "an absurd time");
  answer({}, 500);
  assert.equal(await legMinutes("car", [A, B]), null);
  globalThis.fetch = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  assert.equal(await legMinutes("car", [A, B]), null);
});

test("a network without a routing service is never asked", async () => {
  useNetwork.setState({ terms: { map_tiles_url: "", map_attribution: "", geocoder_url: "", routing_url: null } as unknown as NetworkTerms });
  answer({ code: "Ok", routes: [{ legs: [{ duration: 60 }] }] });
  assert.equal(await legMinutes("car", [A, B]), null);
  assert.deepEqual(await minutesTo(A, [B, C]), [null, null]);
  assert.equal(asked.length, 0);
});

test("stores' drive times to a customer, in one request, each its own", async () => {
  answer({ code: "Ok", durations: [[300], [null]] });
  assert.deepEqual(await minutesTo(A, [B, C]), [5, null]);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].includes("/routed-car/table/v1/driving/") && asked[0].includes("sources=1;2&destinations=0"), asked[0]);
  answer({ code: "Ok", durations: [[300]] });
  assert.deepEqual(await minutesTo(A, [B, C]), [null, null], "an answer for the wrong number of stores");
});
