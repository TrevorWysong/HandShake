# HandShake for desktop

HandShake as an app people download: macOS (Apple Silicon and Intel), Windows and Linux. Each install runs its own Holochain node and keystore, so there's no website to host and no launcher to install first. It's built with [Kangaroo](https://github.com/holochain/kangaroo-electron), Holochain's Electron template.

Closing the window keeps HandShake running from the menu bar or system tray, so a store's orders still arrive and its upkeep still runs. Quit from the tray icon to stop it.

## What's here

| File | What it is |
| --- | --- |
| `network.json` | The network the app joins: its seed, its bootstrap and relay server, and its DNA properties. The bundle is packaged from this file (`npm run package -- --network ../desktop/network.json`) and the app's config reads it too, so the two can't disagree. |
| `kangaroo.config.ts` | The app's identity (`appId`, name, version), its Holochain version and the binaries' SHA-256 hashes. |
| `screens/` | HandShake's own start-up screens: setting up a password (or not), unlocking with it, and starting. Copied over Kangaroo's, with the same file names and the same calls into its preload (`window.electronAPI`), in the app's look. |
| `payments.ts`, `paymentsPreload.ts` | The payment agent in the main process, and the four commands the app's window gets (`window.__HANDSHAKE_PAYMENTS__`). |
| `paymentKeys.ts`, `paymentKeyForm.ts`, `paymentKeys.html`, `paymentKeysPreload.ts` | The window a processor's keys are typed in: its main-process half, what it shares with its preload (the channel, the form and its words in English and Spanish), its page (no script) and its preload. |
| `hardening.ts` | The first thing the main process runs: a packaged app given Chromium's debugging switches quits. |
| `build.ts` | Lays those over a fresh copy of Kangaroo at a pinned commit, applies its fixes, sets Electron's fuses, and builds. |
| `securityCheck.ts` | Checks a built app as an attacker on the same machine would: its fuses, each way of driving it from outside, and the key window (below). |

Kangaroo is meant to be forked. Keeping only HandShake's own files here, with Kangaroo fetched at a pinned commit, keeps the repo small and makes updating Kangaroo a one-line change. The fixes `build.ts` applies:

- **The network seed.** Kangaroo installs the hApp with one seed for every role. HandShake's bundle carries its own seeds, and an upgrade release has two roles on different seeds (docs/MIGRATION.md), so the override is removed.
- **Updates.** Releases and the app's update checks point at this repo's GitHub, not Kangaroo's.
- **The Holochain client.** Kangaroo's lockfile pins a client that sends capability grants in a form the conductor can't read, which the payment agent needs. It's moved to the version `web/` uses, hash and all.
- **Signing at start-up.** The page's first calls come before Kangaroo keeps its signer. They wait for it, and the payment agent starts beside the app rather than ahead of it, so a problem in the agent never stops the app's own calls.
- **The macOS update manifest**, which Kangaroo's script merges for Holochain's own launcher repo.
- **Linux packages** need a homepage, which Kangaroo's `package.json` leaves out.
- **Electron's fuses.** No running as plain Node, no `NODE_OPTIONS`, no `--inspect` or its signal, and only the app's own archive, checked against its hash (macOS and Windows). Another program on the machine can't drive the main process to unseal the processor keys. `file://` pages keep their privileges, as Kangaroo's start-up screens are served from it.
- **Unsigned builds.** Without a certificate, an empty signing secret is unset rather than read as a path, and a macOS build is signed ad hoc -- whole, though anonymous -- so it opens rather than being reported "damaged".

If a Kangaroo update changes what a fix touches, `build.ts` stops and says which one.

## Releasing

1. **Version.** Bump `version` in `kangaroo.config.ts`. Versions that are semver-compatible share one node and its data (0.1.0 to 0.1.4). A breaking bump (0.1 to 0.2) starts a separate, empty one, so bump the minor only for a new network or a new Holochain line.
2. **Build.** In GitHub, Actions, **Desktop**, Run workflow. It packages the bundle once, drafts release `v<version>`, and builds the four installers into it.
3. **Publish** the draft once you've tried an installer. Installed apps find it on their next start and offer to update.

To try a build on your own machine, package the bundle, then `node desktop/build.ts dev` (or `mac-arm64`, `mac-x64`, `win`, `linux`). It needs Yarn 1 (`npm i -g yarn`).

Before publishing a release, run `node desktop/securityCheck.ts` against a build on each platform you're releasing. It checks the fuses, then launches the app every way a program could try to drive it (as plain Node, with `NODE_OPTIONS`, with the inspector's signal, `--inspect`, `--remote-debugging-port`) and confirms none works. Then it drives a copy that differs only in the inspector's fuse. It opens the key window from the app's page and tries to inject script, send a request out, open a popup, navigate away and reach its channel from the app's page. It types a key Stripe refuses, cancels and closes the window, and searches the profile and logs for anything typed. It needs a network connection (Stripe answers the key) and takes a few minutes; it exits non-zero on any failure.

## Before real users

- **The servers.** `network.json` uses Holochain's public test server, which is fine for trying it out and is not for production: it has low bandwidth and no uptime guarantee. Point it at the network's own server (docs/DEPLOYMENT.md, `deploy/`) before anyone relies on it. Changing the server after people have installed splits them into separate networks, so do it with a new network seed and a breaking version bump.
- **Signing, and updates.** Builds are unsigned until the repo has signing secrets. An unsigned build installs and runs, but **doesn't update itself**: an update anyone with release access could publish, unsigned, could replace the app on every machine. Each platform turns on self-updating once its build is signed (`desktop/kangaroo.config.ts`). Add the certificates as secrets of the repo's `release` environment (Settings → Environments → release), not as repository secrets: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` and `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` for macOS, and `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` for Windows. The environment releases only from `main`, and each run waits for the owner's approval before it can read them.
- **Who can release.** Only the repo's owner can push to `main`, create or move tags, or publish a release (rulesets), and a published release can't be changed (immutable releases): a new version is a new release. The release workflow writes only to drafts. Every action it runs is pinned to an exact commit, so a compromised action release can't slip in; Kangaroo's source is checked against a reviewed hash before it runs (`KANGAROO_TREE_SHA256` in `desktop/build.ts`, updated with `KANGAROO_COMMIT`), and its dependencies install exactly as its lockfile pins them. Pull requests from outside run CI only once the owner approves them. Keep two-factor sign-in on for the owner's account.
  - **macOS** asks before opening an app from an unidentified developer: open it once, then allow it under System Settings → Privacy & Security → **Open Anyway**. (A build from before ad-hoc signing reads as "damaged"; `codesign --force --deep --sign - /Applications/HandShake.app` signs it ad hoc in place.) Signing needs an Apple Developer account ($99 a year): set `macOSCodeSigning: true`, add the `APPLE_*` secrets Kangaroo's README lists, and bring over its certificate-import and notarize steps into `.github/workflows/desktop.yml`.
  - **Windows** shows a SmartScreen warning ("More info", then "Run anyway"). Signing needs a certificate: set `windowsEVCodeSigning: true`, add the `AZURE_*` secrets, and bring over Kangaroo's signing step.
  - **Linux** needs nothing.
- **Payments.** There's no money server: stores and drivers connect their own Stripe or Square account under Profile → Payments, and the app's payment agent (`desktop/payments.ts`) holds and charges on it. Their keys are typed in a window of the app's own (`desktop/paymentKeys.ts`), which the app's pages can't see. `network.json` is a test network (`live_payments: false`), so they connect their accounts' test keys.
