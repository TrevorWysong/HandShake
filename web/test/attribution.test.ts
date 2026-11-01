import assert from "node:assert/strict";
import { test } from "node:test";
import { attributionLosses, safeAttribution } from "../src/lib/places/attribution.ts";

test("OpenStreetMap's credit comes through as written", () => {
  assert.equal(
    safeAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  );
});

test("nothing in a credit line can run", () => {
  for (const html of [
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    '<a href="javascript:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<a href="https://ok.example" onclick="alert(1)" style="position:fixed">x</a>',
    "<svg><a xlink:href=javascript:alert(1)>x</a></svg>",
    "<iframe src=https://evil.example></iframe>",
    "&lt;img src=x onerror=alert(1)&gt;",
    "<a href='https://ok.example'>x<a href='https://evil.example'>y</a>",
    "<<b>script>alert(1)<</b>/script>",
  ]) {
    const out = safeAttribution(html);
    const tags = out.match(/<[^>]*>/g) ?? [];
    for (const tag of tags) assert.match(tag, /^(<a href="https?:\/\/[^"]*" target="_blank" rel="noopener noreferrer">|<\/a>)$/, `${html} -> ${out}`);
    assert.equal(tags.filter((t) => t === "</a>").length, tags.length / 2, `${html}: links are balanced`);
    assert.doesNotMatch(tags.join(""), /onerror|onclick|style=|javascript|evil/i, `${html} -> ${out}`);
  }
});

test("an encoded tag stays text", () => {
  assert.equal(safeAttribution("&lt;b&gt;Tiles&lt;/b&gt;"), "&lt;b&gt;Tiles&lt;/b&gt;");
});

test("a credit line is a line, not a page", () => {
  assert.equal(safeAttribution("x".repeat(5000)).length, 300);
});

test("packaging hears what apps leave out", () => {
  assert.deepEqual(attributionLosses('&copy; <a href="https://osm.org">OSM</a>'), { tags: [], cut: false });
  assert.deepEqual(attributionLosses('<b>Tiles</b> <a href="javascript:1">x</a>'), { tags: ["<b>", "</b>", '<a href="javascript:1">', "</a>"], cut: false });
  assert.equal(attributionLosses("x".repeat(301)).cut, true);
});
