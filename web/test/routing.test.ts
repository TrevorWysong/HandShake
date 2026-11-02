import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { forgetRoutes, legMinutes, minutesTo } from "../src/lib/driving/routing.ts";
import { useNetwork } from "../src/store/network.ts";
import type { NetworkTerms } from "../src/holochain/types.ts";

const A = { lat: 27.7676, lon: -82.6403 };
const B = { lat: 27.8126, lon: -82.6403 };
const C = { lat: 27.79, lon: -82.66 };
const realFetch = globalThis.fetch;
let asked: string[] = [];

function answer(body: unknown, status = 200) {
  asked = [];
  forgetRoutes();
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
  assert.ok(asked[0].startsWith("https://routing.openstreetmap.de/routed-bike/route/v1/driving/-82.640,27.768;"), asked[0]);
});

test("points go out rounded to about 100 m, and a repeat shares the answer", async () => {
  answer({ code: "Ok", routes: [{ legs: [{ duration: 60 }] }] });
  await legMinutes("car", [{ lat: 27.767612345, lon: -82.640387654 }, B]);
  await legMinutes("car", [{ lat: 27.76759, lon: -82.64041 }, B]);
  assert.equal(asked.length, 1, "the same rounded trip is asked once");
  assert.ok(!/\d\.\d{4}/.test(asked[0]), asked[0]);
});

test("only an https service is asked -- or a dev machine's own", async () => {
  for (const routing_url of ["http://routing.example.com", "ftp://x", "javascript:alert(1)", "not a url"]) {
    useNetwork.setState({ terms: { routing_url } as unknown as NetworkTerms });
    answer({ code: "Ok", routes: [{ legs: [{ duration: 60 }] }] });
    assert.equal(await legMinutes("car", [A, B]), null, routing_url);
    assert.equal(asked.length, 0, routing_url);
  }
  useNetwork.setState({ terms: { routing_url: "http://localhost:5000" } as unknown as NetworkTerms });
  answer({ code: "Ok", routes: [{ legs: [{ duration: 60 }] }] });
  assert.deepEqual(await legMinutes("car", [A, B]), [1]);
});

test("a burst of trips is asked a few at a time", async () => {
  forgetRoutes();
  let open = 0;
  let most = 0;
  globalThis.fetch = (async () => {
    most = Math.max(most, ++open);
    await new Promise((r) => setTimeout(r, 5));
    open--;
    return new Response(JSON.stringify({ code: "Ok", routes: [{ legs: [{ duration: 60 }] }] }));
  }) as typeof fetch;
  const trips = Array.from({ length: 20 }, (_, i) => legMinutes("car", [A, { lat: 27.7 + i / 100, lon: -82.6 }]));
  assert.ok((await Promise.all(trips)).every((legs) => legs?.[0] === 1));
  assert.ok(most <= 4, `at most 4 at once, saw ${most}`);
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
