// The same cases as validation's (handshake_integrity_support::contact): the
// app's forms and links agree with what the network accepts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { directionsHref, isStoreEmail, isStoreWebsite, mailtoHref, normalizeWebsite, opensAppLinks, telHref, websiteHref, websiteLabel } from "../src/lib/menu/contact.ts";

test("plain addresses pass", () => {
  for (const ok of ["", "hi@mos.com", "first.last+orders@mail.example.co.uk", "o'brien@pub.ie"]) assert.ok(isStoreEmail(ok), ok);
  for (const ok of ["", "https://mos.com", "http://mos.com/menu?day=fri#lunch", "https://Mos-Diner.example.org:8443/a/b", "https://xn--caf-dma.fr"]) assert.ok(isStoreWebsite(ok), ok);
});

test("nothing that could be anything but an address", () => {
  for (const bad of ["mos", "@mos.com", "hi@", "hi@mos", "hi@@mos.com", "a@b@mos.com", "hi there@mos.com", "hi@mos.com?subject=x", "a?cc=them@mos.com", "a%3Fcc@mos.com", "a&b@mos.com", "hi@mos.com\n", "<hi@mos.com>", "hi@-mos.com", "hi@mos.c0m", ".hi@mos.com", "hi..x@mos.com", "hi@mos..com", `${"a".repeat(250)}@mos.com`]) {
    assert.ok(!isStoreEmail(bad), bad);
    assert.equal(mailtoHref(bad), null, bad);
  }
});

test("nothing that could be anything but a web page", () => {
  for (const bad of [
    "mos.com", "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "ftp://mos.com", "https://", "https://mos", "https://good.com@evil.com", "https://user:pw@mos.com",
    'https://mos.com/"onmouseover="x', "https://mos.com/<script>", "https://mos.com/a b", "https://mos.com:99999", "https://mos.com:", "https://mos.com\n", "https://-mos.com", " https://mos.com",
    `https://mos.com/${"a".repeat(200)}`,
  ]) {
    assert.ok(!isStoreWebsite(bad), bad);
    assert.equal(websiteHref(bad), null, bad);
  }
});

test("a website typed loosely is taken as meant", () => {
  assert.equal(normalizeWebsite("  mos.com/menu "), "https://mos.com/menu");
  assert.equal(normalizeWebsite("HTTPS://mos.com"), "https://mos.com");
  assert.equal(normalizeWebsite(""), "");
  assert.equal(normalizeWebsite("javascript:alert(1)"), "javascript:alert(1)", "left for the form to refuse");
  assert.equal(websiteLabel("https://www.Mos-Diner.com:8443/menu"), "mos-diner.com");
});

test("links are only ever a call, an email, a page or directions", () => {
  assert.equal(telHref("(727) 555-0134"), "tel:7275550134");
  assert.equal(telHref(" +1 727 555 0134 ext"), "tel:+17275550134");
  assert.equal(telHref("javascript:alert(1)"), null);
  assert.equal(telHref("javascript:alert(7275550134)"), "tel:7275550134", "only ever its digits");
  assert.equal(telHref("call us!"), null);
  assert.equal(mailtoHref("hi@mos.com"), "mailto:hi@mos.com");
  assert.equal(websiteHref("https://mos.com"), "https://mos.com");
  assert.equal(directionsHref({ lat: 27.7676, lon: -82.6403 }, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"), "https://maps.apple.com/?daddr=27.767600,-82.640300");
  assert.equal(directionsHref({ lat: 27.7676, lon: -82.6403 }, "Mozilla/5.0 (Linux; Android 15)"), "https://www.google.com/maps/dir/?api=1&destination=27.767600,-82.640300");
  assert.equal(directionsHref({ lat: Number.NaN, lon: 0 }, ""), null);
});

test("the desktop app copies what it can't hand to the device", () => {
  assert.equal(opensAppLinks("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 HandShake/0.1.0 Chrome/138.0 Electron/37.2.0 Safari/537.36"), false);
  assert.equal(opensAppLinks("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Mobile/15E148"), true);
});
