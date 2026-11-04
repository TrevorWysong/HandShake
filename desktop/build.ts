// Builds HandShake's desktop app -- an installer that runs its own Holochain
// node, so nobody needs a website or a launcher -- with Kangaroo
// (holochain/kangaroo-electron), pinned below.
//
//   node desktop/build.ts mac-arm64 | mac-x64 | win | linux
//   node desktop/build.ts dev          (runs it, unpackaged)
//
// It needs deploy/handshake.webhapp built for network.json's network first:
//
//   cd web && npm run package -- --network ../desktop/network.json
//
// Kangaroo is a template meant to be forked; this keeps only what's
// HandShake's own (kangaroo.config.ts, network.json) and lays it over a
// fresh copy of Kangaroo in desktop/.kangaroo, with a few fixes (`PATCHES`)
// and the payee's payment agent (desktop/payments.ts, payments/).
// Installers land in desktop/.kangaroo/dist. Releasing is
// .github/workflows/desktop.yml.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(DESKTOP);
const KANGAROO = path.join(DESKTOP, ".kangaroo");
const WEBHAPP = path.join(REPO, "deploy/handshake.webhapp");
const SCREENS = path.join(DESKTOP, "screens");

/// Kangaroo's main branch (its Holochain 0.7 line). Bump deliberately, and
/// re-check that every patch still applies -- this script fails if one doesn't.
const KANGAROO_COMMIT = "68019666ad5c09e2dcdbe1a78e8ac4cdff1537c8";
// What that commit's files hash to (`treeHash`) -- checked before anything
// in them runs, so a swapped download can't reach a signed build. Change
// it with KANGAROO_COMMIT, from a copy you've read.
const KANGAROO_TREE_SHA256 = "9f211a7f941164d2e60a69f06e86700ea2d4feef65d710b183c9afea13d5e761";

/// Where releases (and so auto-updates) live: this repo, or the one CI runs in.
const RELEASES = process.env.GITHUB_REPOSITORY ?? "TrevorWysong/HandShake";
const [OWNER, NAME] = RELEASES.split("/");

const PATCHES = [
  {
    // The payment agent starts once the conductor and the app's window are
    // up (desktop/payments.ts).
    file: "src/main/launch.ts",
    from: "import { HolochainManager } from './holochainManager';\n",
    to: "import { HolochainManager } from './holochainManager';\nimport { startPayments } from './handshakePayments';\n",
  },
  {
    file: "src/main/launch.ts",
    from: "  return {\n    lairHandle,\n    holochainManager,\n    mainWindow,\n    zomeCallSigner,\n  };",
    to: "  await startPayments(holochainManager, mainWindow, kangarooFs);\n\n  return {\n    lairHandle,\n    holochainManager,\n    mainWindow,\n    zomeCallSigner,\n  };",
  },
  {
    // ...and the app's window gets its four commands.
    file: "src/preload/happ.ts",
    from: "contextBridge.exposeInMainWorld('__HC_ZOME_CALL_SIGNER__', {",
    to: `${readFileSync(path.join(DESKTOP, "paymentsPreload.ts"), "utf8")}\ncontextBridge.exposeInMainWorld('__HC_ZOME_CALL_SIGNER__', {`,
  },
  {
    // Kangaroo sends any https navigation, in any frame, to the system
    // browser -- the processors' card forms included, which live in their
    // own frames. Frames stay; the app's content security policy says which
    // may load. (Popups stay refused: one would carry the app's preload.)
    file: "src/main/windows.ts",
    from: "  browserWindow.webContents.on('will-frame-navigate', (e) => {\n",
    to: "  browserWindow.webContents.on('will-frame-navigate', (e) => {\n    if (!e.isMainFrame) return;\n",
  },
  {
    // Kangaroo signs a zome call for whoever asks over IPC. Only a window's
    // own page may -- never a frame inside it, such as a processor's card
    // form. (The app's is the only window: popups are refused.)
    file: "src/main/index.ts",
    from: "  if (!ZOME_CALL_SIGNER) throw new Error('Zome call signer undefined.');\n",
    to: "  if (_e.senderFrame !== _e.sender.mainFrame) throw new Error('Not allowed.');\n  if (!ZOME_CALL_SIGNER) throw new Error('Zome call signer undefined.');\n",
  },
  {
    // payments/ imports its modules by their .ts names, as Node runs them.
    file: "tsconfig.node.json",
    from: '"composite": true',
    to: '"composite": true,\n    "allowImportingTsExtensions": true',
  },
  {
    // Kangaroo installs the hApp with one network seed for every role. Ours
    // carries its seeds already (package.ts), and a migration release has
    // two roles on different seeds -- overriding both would put the
    // `previous` role on the wrong network.
    file: "src/main/holochainManager.ts",
    from: "      network_seed: networkSeed,\n",
    to: "",
  },
  {
    // ...which leaves its parameter unused, and Kangaroo's typecheck refuses
    // an unused one unless it's marked so.
    file: "src/main/holochainManager.ts",
    from: "  async installHappIfNecessary(networkSeed: string) {",
    to: "  async installHappIfNecessary(_networkSeed: string) {",
  },
  {
    // Its macOS update-manifest merge is hardcoded to Holochain's launcher.
    file: "scripts/merge-mac-yamls.mjs",
    from: "const OWNER = 'holochain';\nconst REPO = 'launcher';",
    to: `const OWNER = '${OWNER}';\nconst REPO = '${NAME}';`,
  },
  {
    // Releases, and the auto-updater's checks, go to this repo's GitHub.
    file: "templates/electron-builder-template.yml",
    from: "# publish:\n#   provider: generic\n#   url: https://example.com/auto-updates",
    to: `publish:\n  provider: github\n  owner: ${OWNER}\n  repo: ${NAME}`,
  },
  {
    file: "templates/electron-builder-template.yml",
    from: "  maintainer: electronjs.org",
    to: `  maintainer: ${OWNER}`,
  },
  {
    // A Linux package names its project's homepage; electron-builder reads
    // it from package.json, which Kangaroo's leaves out.
    file: "package.json",
    from: '  "license": "CAL-1.0",\n',
    to: `  "license": "CAL-1.0",\n  "homepage": "https://github.com/${OWNER}/${NAME}",\n`,
  },
];

const TARGETS: Record<string, string> = { "mac-arm64": "build:mac-arm64", "mac-x64": "build:mac-x64", win: "build:win", linux: "build:linux", dev: "dev" };
const target = process.argv[2] ?? "";
const script = TARGETS[target];
if (!script) fail(`Pass a target: ${Object.keys(TARGETS).join(", ")}.`);
if (!existsSync(WEBHAPP)) fail("deploy/handshake.webhapp is missing -- run `npm run package -- --network ../desktop/network.json` in web/ first.");

// A signing secret the release environment doesn't have arrives empty, and
// electron-builder reads an empty certificate path as the folder it's in:
// unset, the build is simply unsigned (as kangaroo.config.ts reads it).
for (const key of ["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
  if (process.env[key] === "") delete process.env[key];
}

// Without an Apple certificate, electron-builder skips signing, and an Apple
// Silicon Mac calls the result "damaged": only its executable carries the
// linker's signature, over resources it doesn't seal. Signed ad hoc instead
// -- anonymous, but whole -- it opens once its user allows it (README). Ad
// hoc, hardened runtime would refuse Electron's own frameworks, signed by
// another team. A build with a certificate is signed as before.
const macUnsigned = target.startsWith("mac") && !(process.env.CSC_LINK && process.env.APPLE_ID && process.env.APPLE_TEAM_ID);
const patches = macUnsigned
  ? [...PATCHES, { file: "templates/electron-builder-template.yml", from: "mac:\n  entitlementsInherit:", to: "mac:\n  identity: '-'\n  hardenedRuntime: false\n  entitlementsInherit:" }]
  : PATCHES;

fetchKangaroo();
copyFileSync(path.join(DESKTOP, "kangaroo.config.ts"), path.join(KANGAROO, "kangaroo.config.ts"));
// The payment agent, beside Kangaroo's main process: payments/ as it is,
// with the network's generated types where its import finds them.
copyFileSync(path.join(DESKTOP, "payments.ts"), path.join(KANGAROO, "src/main/handshakePayments.ts"));
cpSync(path.join(REPO, "payments/src"), path.join(KANGAROO, "src/main/payments/src"), { recursive: true });
mkdirSync(path.join(KANGAROO, "src/main/web/src/holochain"), { recursive: true });
copyFileSync(path.join(REPO, "web/src/holochain/generated.ts"), path.join(KANGAROO, "src/main/web/src/holochain/generated.ts"));
for (const { file, from, to } of patches) {
  const at = path.join(KANGAROO, file);
  const text = readFileSync(at, "utf8");
  if (!text.includes(from)) fail(`Kangaroo's ${file} no longer has what desktop/build.ts patches -- check the patch against KANGAROO_COMMIT.`);
  writeFileSync(at, text.replace(from, to));
}
// HandShake's own start-up screens over Kangaroo's (desktop/screens): the
// same names, so its window loads them, and the same calls into its
// preload. The mark is the app's own icon.
const RENDERER = path.join(KANGAROO, "src/renderer");
for (const name of readdirSync(SCREENS)) {
  const to = path.join(RENDERER, name);
  if (name.endsWith(".html") && !existsSync(to)) fail(`Kangaroo has no ${name} for desktop/screens to replace -- check against KANGAROO_COMMIT.`);
  copyFileSync(path.join(SCREENS, name), to);
}
copyFileSync(path.join(REPO, "web/public/favicon.svg"), path.join(RENDERER, "img/handshake.svg"));
// The one webhapp in its pouch: ours.
copyFileSync(WEBHAPP, path.join(KANGAROO, "pouch/handshake.webhapp"));

// Exactly the dependency versions its lockfile names, or nothing: a
// release never picks up a newer (or swapped) package on its own.
run("yarn", ["install", "--frozen-lockfile"]);
run("yarn", ["setup"]);
run("yarn", [script]);

/// A fresh copy of Kangaroo at KANGAROO_COMMIT, every build, so no earlier
/// build's patches linger -- a tarball, not a clone, so there's no git remote
/// of Kangaroo's around for electron-builder to publish to.
function fetchKangaroo() {
  rmSync(KANGAROO, { recursive: true, force: true });
  mkdirSync(KANGAROO, { recursive: true });
  const tarball = ".kangaroo.tar.gz";
  run("curl", ["-fsSL", "-o", tarball, `https://codeload.github.com/holochain/kangaroo-electron/tar.gz/${KANGAROO_COMMIT}`], DESKTOP);
  // Named relative to desktop/ (where it runs): Windows' GNU tar reads a
  // drive letter -- `D:\...` -- as a remote `host:path`.
  run("tar", ["-xzf", tarball, "-C", path.relative(DESKTOP, KANGAROO), "--strip-components=1"], DESKTOP);
  rmSync(path.join(DESKTOP, tarball));
  const got = treeHash(KANGAROO);
  if (got !== KANGAROO_TREE_SHA256) fail(`Kangaroo's files at ${KANGAROO_COMMIT} aren't what was reviewed (${got}). Nothing from them has run.`);
}

/// A hash of every file under `root`: each one's path and contents, in
/// order -- the same for the same files however they were packed.
function treeHash(root: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const at = path.join(dir, name);
      if (statSync(at).isDirectory()) walk(at);
      else files.push(at);
    }
  };
  walk(root);
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${path.relative(root, file).split(path.sep).join("/")}\0${createHash("sha256").update(readFileSync(file)).digest("hex")}\n`);
  return hash.digest("hex");
}

function run(cmd: string, args: string[], cwd = KANGAROO) {
  console.log(`\n▸ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
