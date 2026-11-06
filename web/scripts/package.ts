// Builds the app as Holochain runtimes install it -- deploy/handshake.webhapp,
// the production hApp plus its production UI -- for a network whose DNA
// properties are in deploy/properties.json (see deploy/properties.example.json
// and docs/DEPLOYMENT.md).
//
//   npm run package -- --network-seed handshake-2026 \
//     [--bootstrap-url https://bootstrap.example.org --relay-url https://relay.example.org]
//
// The bootstrap and relay URLs are the network's own servers (see
// docs/DEPLOYMENT.md); without them, runtimes use their defaults.
//
//   npm run package -- --network ../desktop/network.json
//
// takes the seed, servers and properties from one file instead.
//
// A new version of the network (docs/MIGRATION.md) also carries the one before
// it, so people can move their accounts over:
//
//     --previous deploy/releases/<previous version>
//
// a directory holding that release's handshake.happ and handshake.network.json
// (both written by this script into deploy/: keep a copy of each release).
//
// Everyone on a network must install the same bundle: the properties and
// network seed are part of the DNA hash, so a different value is a
// different, separate network.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO, DNA_PATH } from "./lib/devEnv.ts";
import { attributionLosses } from "../src/lib/places/attribution.ts";

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
// Or the whole network from one file -- `--network desktop/network.json`,
// { network_seed, bootstrap_url, relay_url, properties } -- so whatever
// else reads that file (the desktop build) can't disagree with the bundle.
const networkFile = option("--network");
const network = networkFile ? JSON.parse(readFileSync(path.resolve(networkFile), "utf8")) : {};
const networkSeed = network.network_seed ?? option("--network-seed");
const bootstrapUrl = network.bootstrap_url ?? option("--bootstrap-url");
const previousDir = option("--previous");
const relayUrl = network.relay_url ?? option("--relay-url");
if (!networkSeed) {
  fail("Pass --network-seed <name>: it names the network this bundle joins.");
}

const propertiesPath = path.join(REPO, "deploy/properties.json");
if (!network.properties && !existsSync(propertiesPath)) fail("deploy/properties.json is missing -- copy deploy/properties.example.json and fill it in.");
const properties = network.properties ?? JSON.parse(readFileSync(propertiesPath, "utf8"));

// Every setting must be one the network reads (handshake_governance's
// HandShakeDnaProperties). The DNA ignores a name it doesn't know, so a
// misspelled one would silently leave its feature at the default -- appeals
// off, say -- for everyone, for good.
const governance = readFileSync(path.join(REPO, "dnas/handshake/governance/src/lib.rs"), "utf8");
const struct = governance.slice(governance.indexOf("pub struct HandShakeDnaProperties {"));
const known = [...struct.slice(0, struct.indexOf("\n}")).matchAll(/^\s*pub (\w+):/gm)].map((m) => m[1]);
if (known.length === 0) fail("couldn't read the network's settings from handshake_governance -- has HandShakeDnaProperties moved?");
const unknown = Object.keys(properties).filter((key) => !known.includes(key));
if (unknown.length) {
  const near = (key: string) => known.find((k) => k.startsWith(key.slice(0, 4)) || key.startsWith(k.slice(0, 4)));
  fail(`Unknown network settings: ${unknown.map((key) => (near(key) ? `${key} (did you mean ${near(key)}?)` : key)).join(", ")}. The network ignores a name it doesn't know; fix or remove them.`);
}

// Money: every payment is held on its payer's card by whoever it pays, on
// their own processor account (docs/DIRECT_PAYMENTS.md). A network says,
// in so many words, whether those are live accounts or test ones: it's
// never left to a default.
if (typeof properties.live_payments !== "boolean") {
  fail("The network's settings need \"live_payments\": true for real money (stores and drivers connect live processor accounts), or false for a network of test accounts.");
}
if (!properties.services) {
  console.warn("deploy/properties.json sets no `services`: apps will use OpenStreetMap's public tile and search servers, whose usage policies don't allow production traffic. Set your own (docs/DEPLOYMENT.md).");
}
// Apps show the map's credit as text and http(s) links only
// (src/lib/places/attribution.ts); say what they'd leave out.
if (properties.services) {
  if (typeof properties.services.map_attribution !== "string") fail("services.map_attribution is the map's credit line: text, with <a href=\"https://...\"> links.");
  const lost = attributionLosses(properties.services.map_attribution);
  if (lost.tags.length) console.warn(`services.map_attribution: apps show only its text and http(s) links, so they'll leave out ${lost.tags.join(" ")}.`);
  if (lost.cut) console.warn("services.map_attribution: apps show only its first 300 characters.");
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function step(label: string, cmd: string, cmdArgs: string[], cwd = REPO) {
  console.log(`\n▸ ${label}`);
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit", env: { ...process.env, VITE_HANDSHAKE_DEV_HOST: "false" } });
}

const work = mkdtempSync(path.join(tmpdir(), "handshake-package-"));
try {
  step("Building zomes", "cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"]);
  step("Packing DNA", "hc", ["dna", "pack", "dnas/handshake/workdir"]);

  // The hApp, with this network's properties and seed. JSON is YAML.
  const role = {
    name: "handshake",
    provisioning: { strategy: "create", deferred: false },
    dna: { path: DNA_PATH, modifiers: { properties, network_seed: networkSeed }, clone_limit: 0 },
  };
  const roles = [role];
  if (previousDir) {
    // The previous network, exactly: its own DNA file and the same seed and
    // properties, so it's the network people are moving from.
    const previousNetwork = JSON.parse(readFileSync(path.join(previousDir, "handshake.network.json"), "utf8"));
    step("Unpacking the previous release", "hc", ["app", "unpack", path.join(previousDir, "handshake.happ"), "-o", path.join(work, "previous")]);
    roles.push({
      name: "previous",
      provisioning: { strategy: "create", deferred: false },
      dna: { path: path.join(work, "previous", "handshake.dna"), modifiers: { properties: previousNetwork.properties, network_seed: previousNetwork.network_seed }, clone_limit: 0 },
    });
  }
  const manifest = { manifest_version: "0", name: "handshake", description: "HandShake -- food delivery with no middleman, on Holochain", roles, bootstrap_url: bootstrapUrl ?? null, relay_url: relayUrl ?? null };
  writeFileSync(path.join(work, "happ.yaml"), JSON.stringify(manifest, null, 2));
  step("Packing hApp", "hc", ["app", "pack", work]);
  // What servers that run a node of their own install (docs/DEPLOYMENT.md).
  copyFileSync(path.join(work, "handshake.happ"), path.join(REPO, "deploy/handshake.happ"));
  // What a later release needs to carry this network as its previous one.
  writeFileSync(path.join(REPO, "deploy/handshake.network.json"), `${JSON.stringify({ network_seed: networkSeed, properties }, null, 2)}\n`);

  // The production UI: no dev host, so no Admin API code (see
  // src/holochain/host.ts), and none of the dev-only public files.
  // The app may only talk to the servers this network names (scripts/lib/csp.ts).
  process.env.HANDSHAKE_NETWORK_PROPERTIES = JSON.stringify(properties);
  step("Building the UI", "npm", ["run", "build"], path.join(REPO, "web"));
  const dist = path.join(REPO, "web/dist");
  // The dev payment agents' token and the dev network's settings are this
  // machine's alone: never shipped, whatever's running while it builds.
  for (const devOnly of ["handshake.happ", "sw.js", "dev-network.json", "dev-payments.json"]) rmSync(path.join(dist, devOnly), { force: true });
  step("Zipping the UI", "zip", ["-q", "-r", path.join(work, "ui.zip"), "."], dist);

  writeFileSync(path.join(work, "web-happ.yaml"), JSON.stringify({ manifest_version: "0", name: "handshake", ui: { path: "./ui.zip" }, happ: { path: "./handshake.happ" } }, null, 2));
  const out = path.join(REPO, "deploy/handshake.webhapp");
  step("Packing the web hApp", "hc", ["web-app", "pack", work, "-o", out]);

  console.log(`\n✓ ${path.relative(REPO, out)} (${Math.round(statSync(out).size / 1024)} KB)`);
  console.log(`  network seed: ${networkSeed}`);
  console.log(`  payments:     ${properties.live_payments ? "live" : "test"}`);
  console.log(`  previous:     ${previousDir ?? "(none)"}`);
  console.log(`  bootstrap:    ${bootstrapUrl ?? "(runtime default)"}`);
  console.log(`  relay:        ${relayUrl ?? "(runtime default)"}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
