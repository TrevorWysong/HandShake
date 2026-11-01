import assert from "node:assert/strict";
import { test } from "node:test";
import { locationSharer, SHARE_EVERY_MS } from "../src/lib/driving/locationShare.ts";

/// A device whose position the test moves, counting the watches on it.
function fakeDevice() {
  const watches = new Map<number, PositionCallback>();
  let next = 1;
  const geolocation = {
    watchPosition: (cb: PositionCallback) => (watches.set(next, cb), next++),
    clearWatch: (id: number) => void watches.delete(id),
  } as unknown as Geolocation;
  const moveTo = (lat: number, lon: number) => watches.forEach((cb) => cb({ coords: { latitude: lat, longitude: lon } } as GeolocationPosition));
  return { geolocation, watches, moveTo };
}

test("one watch serves every delivery, and stops with the last", () => {
  const device = fakeDevice();
  const share = locationSharer(device.geolocation, async () => {});
  const stopA = share("aa");
  const stopB = share("bb");
  assert.equal(device.watches.size, 1);
  stopA();
  assert.equal(device.watches.size, 1, "still carrying one");
  stopB();
  assert.equal(device.watches.size, 0);
});

test("each customer hears at most so often", () => {
  const device = fakeDevice();
  const sent: string[] = [];
  let clock = 0;
  const share = locationSharer(device.geolocation, async (hex, lat) => void sent.push(`${hex}@${lat}`), () => clock);
  share("aa");
  device.moveTo(1, 0);
  clock += SHARE_EVERY_MS - 1;
  device.moveTo(2, 0);
  clock += 1;
  device.moveTo(3, 0);
  assert.deepEqual(sent, ["aa@1", "aa@3"]);
});

test("a screen mounting twice, or stopping twice, can't stop someone else's sharing", () => {
  const device = fakeDevice();
  const sent: string[] = [];
  const share = locationSharer(device.geolocation, async (hex) => void sent.push(hex));
  const first = share("aa");
  const second = share("aa");
  first();
  first();
  device.moveTo(1, 0);
  assert.deepEqual(sent, ["aa"], "still shared while the second holds it");
  second();
  assert.equal(device.watches.size, 0);
});

test("without location, nothing happens", () => {
  const share = locationSharer(undefined, async () => assert.fail("nothing to send"));
  share("aa")();
});
