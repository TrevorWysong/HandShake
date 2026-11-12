// Apple not answering ties up none of the relay's delivery slots for long:
// each request is given up at its deadline, and the connection it hung on
// is dropped -- the next wake opens a fresh one and goes through.
import assert from "node:assert/strict";
import { createServer, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { http2Request } from "../src/channels/apns.ts";

test("a request Apple never answers is given up at the deadline, and the next goes through on a fresh connection", async () => {
  let answer = false;
  const sessions = new Set<unknown>();
  const server = createServer();
  server.on("session", (session) => sessions.add(session));
  server.on("stream", (stream: ServerHttp2Stream) => {
    // Holds the first request open forever; answers once told to.
    if (!answer) return;
    stream.respond({ ":status": 200 });
    stream.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = http2Request(false, 100, origin);
  try {
    const started = Date.now();
    await assert.rejects(request("/3/device/aa", {}, "{}"), /didn't answer within 100 ms/);
    assert.ok(Date.now() - started < 2_000, "at the deadline");
    answer = true;
    assert.deepEqual(await request("/3/device/aa", {}, "{}"), { status: 200, reason: undefined }, "the next wake goes through");
    assert.equal(sessions.size, 2, "on a fresh connection, not the one that hung");
  } finally {
    for (const session of sessions) (session as { destroy(): void }).destroy();
    await new Promise((done) => server.close(done));
  }
});

test("FCM and Web Push requests are given up at their deadline too", async () => {
  const { withDeadline } = await import("../src/channels/channel.ts");
  const hung = (_url: string, init: { signal?: AbortSignal }) => new Promise<never>((_, fail) => init.signal?.addEventListener("abort", () => fail(init.signal!.reason)));
  const started = Date.now();
  await assert.rejects(withDeadline(hung, 50)("https://fcm.googleapis.com/", { method: "POST", headers: {} }), (err: Error) => err.name === "TimeoutError");
  assert.ok(Date.now() - started < 2_000);
});

test("an answer that trickles in, a byte at a time, is given up at the deadline all the same", async () => {
  const sessions = new Set<{ destroy(): void }>();
  const server = createServer();
  server.on("session", (session) => sessions.add(session));
  const drips: ReturnType<typeof setInterval>[] = [];
  server.on("stream", (stream: ServerHttp2Stream) => {
    stream.respond({ ":status": 200 });
    // Never finishes: a byte well inside any idle timeout, forever.
    drips.push(setInterval(() => !stream.destroyed && stream.write(" "), 20));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const request = http2Request(false, 200, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    const started = Date.now();
    await assert.rejects(request("/3/device/aa", {}, "{}"), /didn't answer within 200 ms/);
    assert.ok(Date.now() - started < 1_500, "at the deadline from its start, not kept alive by the trickle");
  } finally {
    for (const drip of drips) clearInterval(drip);
    for (const session of sessions) session.destroy();
    await new Promise((done) => server.close(done));
  }
});
