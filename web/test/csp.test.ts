import assert from "node:assert/strict";
import { test } from "node:test";
import { networkOrigins, serviceOrigin } from "../scripts/lib/csp.ts";

test("a network with no settings of its own allows the network's defaults", () => {
  const { img, connect } = networkOrigins({});
  assert.deepEqual(img, ["https://*.tile.openstreetmap.org"]);
  assert.deepEqual(connect, ["https://nominatim.openstreetmap.org", "https://routing.openstreetmap.de", "https://api.drand.sh", "https://drand.cloudflare.com"]);
});

test("a network's own services replace them, and nothing else is let in", () => {
  const { img, connect } = networkOrigins({
    services: { map_tiles_url: "https://tiles.example.com/{z}/{x}/{y}.png", geocoder_url: "https://geo.example.com/search", routing_url: null, push_relay_url: "https://push.example.com" },
    time_source: { relays: ["https://time.example.com"] },
  });
  assert.deepEqual(img, ["https://tiles.example.com"]);
  assert.deepEqual(connect, ["https://geo.example.com", "https://push.example.com", "https://time.example.com"]);
});

test("only a plain https URL gets into a policy", () => {
  assert.equal(serviceOrigin("https://a.example.com:8443/x"), "https://a.example.com:8443");
  for (const bad of ["http://example.com", "javascript:alert(1)", "https://user:pw@example.com", "https://exa mple.com; script-src *", "not a url"]) {
    assert.throws(() => serviceOrigin(bad), Error, bad);
  }
});
