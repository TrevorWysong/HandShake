// Web Push (RFC 8030), for the app in a browser: an installed web app, or
// Chrome on Android, or Safari from iOS 16.4. A wake is a push with no
// payload -- so nothing to encrypt (RFC 8291) -- authorised by the relay's
// VAPID key (RFC 8292). The service worker shows the notification.
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { DELIVERY_TIMEOUT_MS, jwt, withDeadline, type Fetch, type Outcome, type Sender } from "./channel.ts";

/// How long a push service keeps a wake for a device that's offline: past
/// this, the moment it was about has gone.
const TTL_SECS = 60 * 60;
const VAPID_LIFETIME_SECS = 12 * 60 * 60;

/// The browsers' push services: Chrome's, Firefox's, Edge's and Safari's. A
/// subscription's endpoint is the client's to write, and the relay posts to
/// it -- so only to these, over https, never to an address of the client's
/// choosing (the relay's own network, a cloud's metadata service).
export const WEB_PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];

/// A subscription's endpoint, if it's one of `hosts`' over https. A host
/// starting with "." stands for any under it.
export function pushEndpoint(address: string, hosts: readonly string[] = WEB_PUSH_HOSTS): URL | null {
  let endpoint: URL;
  try {
    endpoint = new URL((JSON.parse(address) as { endpoint: unknown }).endpoint as string);
  } catch {
    return null;
  }
  const host = endpoint.hostname.toLowerCase();
  const known = hosts.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
  return endpoint.protocol === "https:" && !endpoint.port && !endpoint.username && !endpoint.password && known ? endpoint : null;
}

export interface Vapid {
  /// The private key, PKCS#8 PEM (P-256).
  privateKey: string;
  /// Who to contact about this relay's pushes: a `mailto:` or `https:` URL.
  subject: string;
}

/// The VAPID public key a browser subscribes with: the raw uncompressed
/// P-256 point, base64url.
export function vapidPublicKey(privateKey: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKey)).export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
}

export function webPushSender(vapid: Vapid, unbounded: Fetch, hosts: readonly string[] = WEB_PUSH_HOSTS, timeoutMs = DELIVERY_TIMEOUT_MS): Sender {
  const fetch = withDeadline(unbounded, timeoutMs);
  const key: KeyObject = createPrivateKey(vapid.privateKey);
  const publicKey = vapidPublicKey(vapid.privateKey);
  return {
    accepts: (address) => pushEndpoint(address, hosts) !== null,
    async send(address: string): Promise<Outcome> {
      const endpoint = pushEndpoint(address, hosts);
      if (!endpoint) return "gone";
      const token = jwt("ES256", {}, { aud: endpoint.origin, exp: Math.floor(Date.now() / 1000) + VAPID_LIFETIME_SECS, sub: vapid.subject }, key);
      const response = await fetch(endpoint.href, {
        method: "POST",
        headers: { Authorization: `vapid t=${token}, k=${publicKey}`, TTL: String(TTL_SECS), Urgency: "high", "Content-Length": "0" },
      });
      // 404 and 410: the subscription is gone (unsubscribed, expired).
      if (response.status === 404 || response.status === 410) return "gone";
      return response.status >= 200 && response.status < 300 ? "sent" : "failed";
    },
  };
}
