// A store's contact details as links customers tap -- call, email, website,
// directions. The rules for what a store may give are validation's
// (`handshake_integrity_support::contact`), mirrored here for its forms; and
// every link is built only from details that pass them, so whatever a
// store's entry holds, a link can only ever call a number, write to an
// address, or open a web page.
import type { GeoPoint } from "../../holochain/types";
import { MAX_EMAIL_CHARS, MAX_WEBSITE_CHARS } from "../../holochain/types";

/// A domain name: two or more labels of letters, digits and inner hyphens,
/// the last all letters.
function isDomain(domain: string): boolean {
  const labels = domain.split(".");
  const labelOk = (l: string) => l.length > 0 && l.length <= 63 && /^[a-z0-9-]+$/i.test(l) && !l.startsWith("-") && !l.endsWith("-");
  const tld = labels[labels.length - 1];
  return labels.length >= 2 && labels.every(labelOk) && tld.length >= 2 && /^[a-z]+$/i.test(tld);
}

/// Whether `email` is an address a store can give (or empty).
export function isStoreEmail(email: string): boolean {
  if (email === "") return true;
  if ([...email].length > MAX_EMAIL_CHARS) return false;
  const at = email.indexOf("@");
  if (at < 0 || at !== email.lastIndexOf("@")) return false;
  const [local, domain] = [email.slice(0, at), email.slice(at + 1)];
  const localOk = local.length > 0 && local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") && /^[a-z0-9._+'-]+$/i.test(local);
  return localOk && isDomain(domain);
}

/// Whether `website` is a web address a store can give (or empty): http(s),
/// a host with no `user@` before it, and a path that can't break out of a
/// link.
export function isStoreWebsite(website: string): boolean {
  if (website === "") return true;
  if ([...website].length > MAX_WEBSITE_CHARS) return false;
  const scheme = website.startsWith("https://") ? 8 : website.startsWith("http://") ? 7 : 0;
  if (!scheme) return false;
  const rest = website.slice(scheme);
  const end = rest.search(/[/?#]/);
  const [authority, path] = end < 0 ? [rest, ""] : [rest.slice(0, end), rest.slice(end)];
  const colon = authority.lastIndexOf(":");
  let host = authority;
  if (colon >= 0) {
    const port = authority.slice(colon + 1);
    if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return false;
    host = authority.slice(0, colon);
  }
  return isDomain(host.toLowerCase()) && /^[!#-&(-;=?-[\]_a-z~]*$/i.test(path);
}

/// What a store owner typed, as they meant it: trimmed, and a bare
/// `mos.com` taken as `https://mos.com`.
export function normalizeWebsite(typed: string): string {
  const website = typed.trim();
  if (website === "" || /^[a-z][a-z0-9+.-]*:/i.test(website)) return website.replace(/^https?:\/\//i, (scheme) => scheme.toLowerCase());
  return `https://${website}`;
}

/// A `tel:` link for a phone number as a store wrote it ("(727) 555-0134"),
/// if it has a number in it: its digits, and a leading `+`.
export function telHref(phone: string): string | null {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 3 || digits.length > 20) return null;
  return `tel:${phone.trim().startsWith("+") ? "+" : ""}${digits}`;
}

export function mailtoHref(email: string): string | null {
  return email && isStoreEmail(email) ? `mailto:${email}` : null;
}

export function websiteHref(website: string): string | null {
  return website && isStoreWebsite(website) ? website : null;
}

/// A website as a person reads it: its host, without `www.`.
export function websiteLabel(website: string): string {
  const rest = website.replace(/^https?:\/\//i, "");
  return rest.slice(0, rest.search(/[/?#:]|$/)).replace(/^www\./i, "").toLowerCase();
}

/// Directions to a store, in the maps app a device has: Apple Maps on Apple
/// devices, Google Maps elsewhere (which opens its app where there is one).
/// From the store's coordinates alone -- numbers, so the link is only ever
/// directions.
export function directionsHref(location: GeoPoint, userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): string | null {
  const { lat, lon } = location;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const to = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  return /iPhone|iPad|iPod|Macintosh/.test(userAgent) ? `https://maps.apple.com/?daddr=${to}` : `https://www.google.com/maps/dir/?api=1&destination=${to}`;
}

/// Whether this runtime hands `tel:` and `mailto:` links to the device. A
/// browser or phone does; the desktop app's shell opens only web pages, so
/// there a number or address is copied instead.
export function opensAppLinks(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return !/\bElectron\//.test(userAgent);
}
