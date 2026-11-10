import assert from "node:assert/strict";
import { test } from "node:test";
import { locate, pointAlong, roadBetween } from "../src/lib/places/alongPath.ts";
import { distanceKm } from "../src/lib/places/geohash.ts";

// An L-shaped road: about 1 km north, then about 1 km east.
const SOUTH = { lat: 27.76, lon: -82.64 };
const CORNER = { lat: 27.769, lon: -82.64 };
const EAST = { lat: 27.769, lon: -82.6298 };
const ROAD = [SOUTH, CORNER, EAST];
/// `p`, moved `east` and `north` metres.
const moved = (p: { lat: number; lon: number }, east: number, north: number) => ({ lat: p.lat + north / 111_200, lon: p.lon + east / (111_200 * Math.cos((p.lat * Math.PI) / 180)) });
const near = (a: { lat: number; lon: number }, b: { lat: number; lon: number }, metres = 2) => assert.ok(distanceKm(a, b) * 1000 < metres, `${JSON.stringify(a)} is ${Math.round(distanceKm(a, b) * 1000)} m from ${JSON.stringify(b)}`);

test("a position is put at its nearest point on the road, and how far along it is", () => {
  const found = locate(ROAD, moved(CORNER, 20, -300))!;
  near(found.at, moved(CORNER, 0, -300));
  assert.ok(Math.abs(found.off - 0.02) < 0.002);
  assert.ok(Math.abs(found.along - (distanceKm(SOUTH, CORNER) - 0.3)) < 0.005);
  assert.equal(locate([SOUTH], CORNER), null);
});

test("between two positions on the road, the way turns its corners", () => {
  const from = moved(CORNER, 0, -200);
  const to = moved(CORNER, 300, 10);
  const way = roadBetween(ROAD, from, to);
  assert.equal(way.length, 4);
  near(way[2], CORNER);
  // Ends on the road, not where GPS drifted to.
  near(way.at(-1)!, moved(CORNER, 300, 0));
});

test("off the road, turned back, or with no road drawn, it goes straight", () => {
  const from = moved(CORNER, 0, -200);
  assert.deepEqual(roadBetween(null, from, CORNER), [from, CORNER]);
  const away = moved(CORNER, -400, 0);
  assert.deepEqual(roadBetween(ROAD, from, away), [from, away]);
  const back = roadBetween(ROAD, from, moved(CORNER, 0, -500));
  assert.equal(back.length, 2);
  near(back[1], moved(CORNER, 0, -500));
});

test("a point part-way along a way is measured by distance, around corners", () => {
  const way = [moved(CORNER, 0, -100), CORNER, moved(CORNER, 300, 0)];
  near(pointAlong(way, 0), way[0]);
  near(pointAlong(way, 0.25), CORNER);
  near(pointAlong(way, 0.5), moved(CORNER, 100, 0));
  near(pointAlong(way, 1), way[2]);
  near(pointAlong(way, 7), way[2]);
  near(pointAlong([CORNER, CORNER], 0.5), CORNER);
});
