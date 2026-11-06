// The outside servers a network's app may talk to, for the production build's
// Content-Security-Policy: those its own settings name, and nothing else. They're
// fixed when the bundle's built, from the same properties that make the network.

export interface ServiceProperties {
  services?: { map_tiles_url?: string; geocoder_url?: string; routing_url?: string | null; push_relay_url?: string | null } | null;
  time_source?: { relays?: string[] } | null;
}

// The network's own defaults (`handshake_governance::{services, time_source}`).
const DEFAULT_SERVICES = {
  map_tiles_url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  geocoder_url: "https://nominatim.openstreetmap.org",
  routing_url: "https://routing.openstreetmap.de/routed-{profile}",
  push_relay_url: null,
};
const DEFAULT_RELAYS = ["https://api.drand.sh", "https://drand.cloudflare.com"];

/// A service's origin, from its URL or template: `{s}` in a host (a tile
/// server's mirrors) becomes a wildcard. Anything but https is refused, as is
/// anything a policy could misread: a service's URL comes from whoever packages
/// the network, and goes straight into the policy.
export function serviceOrigin(url: string): string {
  const mirrored = /^https:\/\/\{s\}\./.test(url);
  const parsed = new URL(url.replace("{s}", "mirror").replace(/\{[a-z]+\}/g, "x"));
  if (parsed.protocol !== "https:" || !/^[a-z0-9.-]+$/i.test(parsed.hostname) || parsed.username || parsed.password) throw new Error(`a network's services must be plain https URLs: ${url}`);
  const host = mirrored ? parsed.host.replace(/^mirror\./, "*.") : parsed.host;
  return `https://${host}`;
}

/// What the policy allows for a network with these properties.
export function networkOrigins(properties: ServiceProperties): { img: string[]; connect: string[] } {
  const services = properties.services ?? DEFAULT_SERVICES;
  const relays = properties.time_source?.relays ?? DEFAULT_RELAYS;
  const connect = [services.geocoder_url, services.routing_url, services.push_relay_url, ...relays].filter((url): url is string => !!url);
  return { img: services.map_tiles_url ? [serviceOrigin(services.map_tiles_url)] : [], connect: [...new Set(connect.map(serviceOrigin))] };
}
