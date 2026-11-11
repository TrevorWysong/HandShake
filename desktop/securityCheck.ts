// Checks the built desktop app as an attacker on the same machine would --
// the packaged app itself, not the code it came from:
//
//   node desktop/build.ts mac-arm64     (or mac-x64, win, linux)
//   node desktop/securityCheck.ts
//
// First, that nothing else can drive it (build.ts, desktop/hardening.ts):
//   - its fuses: no running as plain Node, no NODE_OPTIONS, no --inspect or
//     its signal, and only its own archive, checked against its hash;
//   - and so, launched each of those ways, it runs no code it's given and
//     opens no inspector; given Chromium's debugging switches, it quits.
// Then, to drive it, it makes a copy that differs only in the inspector's
// fuse, runs that under a profile of its own (deleted after), attaches to
// its main process, and asks for Stripe's keys from the app's page, as the
// Payments screen does. Then it tries to get past the key window
// (desktop/paymentKeys.ts) and checks what's left behind:
//   - the page's request names the processor only: keys it passes are ignored;
//   - the window is modal, sandboxed, isolated, without Node, and left out of
//     screenshots (macOS and Windows; Linux has no such thing);
//   - its page runs no script, injected or otherwise, sends nothing out,
//     opens nothing, and can't be navigated away;
//   - the app's page has no way to its channel;
//   - keys typed there reach the agent -- and appear nowhere in the profile
//     or its logs after the processor refuses them;
//   - cancelling, Escape and closing the window change nothing, and a second
//     request while it's open opens no second window.
// It exits non-zero on any failure. The app must already be built.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const DESKTOP = path.dirname(fileURLToPath(import.meta.url));
const KANGAROO = path.join(DESKTOP, ".kangaroo");
const DIST = path.join(KANGAROO, "dist");
const PROFILE = `security-check-${randomBytes(4).toString("hex")}`;
const INSPECTOR_PORT = 9229;
const INSPECTOR = `http://127.0.0.1:${INSPECTOR_PORT}/json/list`;
/// The fuses the build sets, as Kangaroo's copy of electron/fuses reads them.
const fuses = createRequire(path.join(KANGAROO, "package.json"))("@electron/fuses") as typeof import("@electron/fuses");
const { FuseV1Options, FuseVersion, getCurrentFuseWire, flipFuses } = fuses;
const ON = 49;
const OFF = 48;

const failures: string[] = [];
function check(passed: boolean, what: string) {
  console.log(`${passed ? "  ✓" : "  ✗"} ${what}`);
  if (!passed) failures.push(what);
}

/// The packaged app, for this platform: what's copied (`root`), what's run
/// (`executable`), relative to it, and what fuses are read from (`fused`).
function built(): { root: string; executable: string; fused: string } {
  const named = (key: string) => new RegExp(`${key}:\\s*\\n\\s*executableName:\\s*(\\S+)`).exec(readFileSync(path.join(KANGAROO, "electron-builder.yml"), "utf8"))?.[1];
  const pkg = JSON.parse(readFileSync(path.join(KANGAROO, "package.json"), "utf8")) as { name: string };
  const candidates: Record<string, { root: string; executable: string; fused: string }[]> = {
    darwin: ["mac-arm64", "mac"].map((dir) => ({ root: `${dir}/HandShake.app`, executable: "Contents/MacOS/HandShake", fused: "" })),
    win32: [`${named("win") ?? "HandShake"}.exe`, "HandShake.exe"].map((exe) => ({ root: "win-unpacked", executable: exe, fused: exe })),
    linux: [named("linux"), pkg.name, "handshake", "HandShake"].filter((exe): exe is string => !!exe).map((exe) => ({ root: "linux-unpacked", executable: exe, fused: exe })),
  };
  const found = (candidates[process.platform] ?? []).find((app) => existsSync(path.join(DIST, app.root, app.executable)));
  if (!found) throw new Error(`No built app in ${DIST}: run desktop/build.ts first.`);
  return { ...found, root: path.join(DIST, found.root) };
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(read: () => Promise<T | undefined | null | false>, what: string, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await wait(500);
  }
}

/// Whether anything answers at `url` now.
const answers = (url: string) => fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);

/// The app at `executable`, started with `args` and `env`, and what it's said.
function launch(executable: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  return { child, exited, output: () => output };
}

/// Whether `exited` settles within `ms`: its code if so.
const exitsWithin = (exited: Promise<number | null>, ms: number) => Promise.race([exited.then((code) => ({ code })), wait(ms).then(() => null)]);

/// Stops a launch that's still running, and anything it started: its
/// conductor and keystore, which run under the check's profile, from where
/// the app is (`from`).
async function stop(child: ChildProcess, exited: Promise<number | null>, from: string) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (!(await exitsWithin(exited, 15_000))) child.kill("SIGKILL");
  if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)]);
  else for (const started of [PROFILE, from]) spawnSync("pkill", ["-f", started]);
}

/// Node's inspector, opened from outside: `process._debugProcess` works on
/// every platform, where SIGUSR1 doesn't on Windows.
const openInspector = (pid: number) => (process as unknown as { _debugProcess: (pid: number) => void })._debugProcess(pid);

/// The built app's fuses, and each way in they shut, tried.
async function noWayIn(app: { root: string; executable: string; fused: string }) {
  const executable = path.join(app.root, app.executable);
  console.log("Its fuses:");
  const wire = (await getCurrentFuseWire(path.join(app.root, app.fused))) as unknown as Record<number, number>;
  check(wire[FuseV1Options.RunAsNode] === OFF, "it can't be run as plain Node");
  check(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable] === OFF, "it ignores NODE_OPTIONS");
  check(wire[FuseV1Options.EnableNodeCliInspectArguments] === OFF, "it ignores --inspect and its signal");
  check(wire[FuseV1Options.OnlyLoadAppFromAsar] === ON, "it runs only its own archive");
  check(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] === ON, "which is checked against the hash built into it");

  console.log("Launched to be driven from outside, it isn't:");
  if (await answers(INSPECTOR)) throw new Error(`Something already answers on port ${INSPECTOR_PORT}: stop it, then check again.`);
  const marker = `ran-${randomBytes(6).toString("hex")}`;
  const probe = path.join(mkdtempSync(path.join(tmpdir(), "handshake-probe-")), "probe.cjs");
  writeFileSync(probe, `console.log(${JSON.stringify(marker)});\n`);
  try {
    const asNode = launch(executable, ["-e", `console.log(${JSON.stringify(marker)})`], { ELECTRON_RUN_AS_NODE: "1" });
    await exitsWithin(asNode.exited, 10_000);
    await stop(asNode.child, asNode.exited, app.root);
    check(!asNode.output().includes(marker), "as plain Node, it runs none of the code it's given");

    const started = launch(executable, ["--profile", PROFILE], { NODE_OPTIONS: `--require ${probe}` });
    await until(async () => /userData directory/.test(started.output()) || started.child.exitCode !== null, "the app to start", 60_000);
    check(!started.output().includes(marker), "with NODE_OPTIONS, it runs none of the code they name");
    if (started.child.exitCode === null) openInspector(started.child.pid!);
    await wait(3000);
    check(!(await answers(INSPECTOR)), "sent the inspector's signal, it opens no inspector");
    await stop(started.child, started.exited, app.root);

    for (const [flag, port] of [["--inspect", 9339], ["--remote-debugging-port", 9333]] as const) {
      const debugged = launch(executable, ["--profile", PROFILE, `${flag}=${port}`]);
      const url = flag === "--inspect" ? `http://127.0.0.1:${port}/json/list` : `http://127.0.0.1:${port}/json/version`;
      let opened = false;
      const quit = await Promise.race([
        debugged.exited.then((code) => ({ code })),
        (async () => {
          for (let i = 0; i < 40 && !opened; i++) (opened = await answers(url)) || (await wait(500));
          return null;
        })(),
      ]);
      opened ||= await answers(url);
      await stop(debugged.child, debugged.exited, app.root);
      // Quit by the app's own refusal (desktop/hardening.ts), before anything
      // else runs -- not by chance, its command line's parser refusing a flag.
      check(!opened && quit !== null && quit.code !== 0 && debugged.output().includes(`Refusing to start with ${flag}`), `given ${flag}, it refuses to start, opening no port`);
    }
  } finally {
    rmSync(path.dirname(probe), { recursive: true, force: true });
  }
}

/// A copy of the built app whose one difference is the inspector's fuse, to
/// drive it -- re-signed ad hoc on macOS, as changing its binary breaks the
/// signature. Nothing it runs differs: its archive is the build's own.
async function inspectable(app: { root: string; executable: string; fused: string }): Promise<{ root: string; executable: string; remove: () => void }> {
  const dir = mkdtempSync(path.join(tmpdir(), "handshake-security-check-"));
  const root = path.join(dir, path.basename(app.root));
  cpSync(app.root, root, { recursive: true, verbatimSymlinks: true });
  await flipFuses(path.join(root, app.fused), { version: FuseVersion.V1, resetAdHocDarwinSignature: process.platform === "darwin", [FuseV1Options.EnableNodeCliInspectArguments]: true });
  return { root, executable: path.join(root, app.executable), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/// Runs `body` in the app's main process, where `electron` is in scope, and
/// returns what it returns.
async function inMain<T>(body: string): Promise<T> {
  const [target] = (await (await fetch(INSPECTOR)).json()) as { webSocketDebuggerUrl: string }[];
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ready) => socket.addEventListener("open", ready, { once: true }));
  const expression = `(async () => { const electron = process.mainModule.require("electron"); const { BrowserWindow } = electron; ${body} })()`;
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  const reply = await new Promise<{ result?: { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } } }>((done) =>
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data));
      if (data.id === 1) done(data);
    }),
  );
  socket.close();
  const failed = reply.result?.exceptionDetails?.exception?.description;
  if (failed) throw new Error(failed);
  return reply.result?.result?.value as T;
}

/// Lines that find the app's window and the key window, for `inMain`.
const WINDOWS = `
  const app = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("webhapp://"));
  const keyWindow = () => BrowserWindow.getAllWindows().find((w) => w !== app && !w.isDestroyed());
  const inApp = (js) => app.webContents.executeJavaScript(js);
  const connect = (args) => inApp("window.__HANDSHAKE_PAYMENTS__.connect(" + args + ").then((done) => ({ done }), (e) => ({ error: String(e.message) }))");
`;

/// Every file under `dir` -- for what was left behind.
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const at = path.join(dir, name);
    return statSync(at).isDirectory() ? files(at) : [at];
  });
}

async function main() {
  const app = built();
  await noWayIn(app);

  const copy = await inspectable(app);
  const launched = launch(copy.executable, ["--profile", PROFILE]);
  const output = launched.output;
  const userData = await until(async () => /userData directory[^:]*:\s+(.+)/.exec(output())?.[1]?.trim(), "the app to say where its profile is");
  const logs = await until(async () => /logsDir:\s+(.+)/.exec(output())?.[1]?.trim(), "the app to say where its logs are");
  try {
    openInspector(launched.child.pid!);
    await until(async () => (await fetch(INSPECTOR)).ok, "the inspector");
    // A fresh profile starts at the password screen: on without one --
    // chosen once, as setting up twice would start two keystores -- then
    // waiting for the app's own window.
    await until(
      () =>
        inMain<boolean>(`
          const windows = BrowserWindow.getAllWindows();
          if (windows.some((w) => w.webContents.getURL().startsWith("webhapp://"))) return true;
          const setup = windows.find((w) => w.webContents.getURL().endsWith("setupPasswordOptional.html"));
          if (setup && !globalThis.__setUp) globalThis.__setUp = await setup.webContents.executeJavaScript('(() => { const button = document.getElementById("without-password"); button?.click(); return !!button; })()');
          return false;
        `),
      "the app's window",
      300_000,
    );

    // The payment agent starts beside the app, trying again if the new
    // install's conductor is busy: on once it answers.
    await until(() => inMain<boolean>(`${WINDOWS} return inApp("window.__HANDSHAKE_PAYMENTS__.status().then(() => true, () => false)");`), "the payment agent", 180_000);

    console.log("The key window, opened from the app's page:");
    const marker = `rk_test_securitycheck${randomBytes(8).toString("hex")}`;
    const opened = await inMain<Record<string, unknown>>(`${WINDOWS}
      // Keys passed by the page are ignored: the window asks for its own.
      globalThis.__pending = connect('"Stripe", { publishable_key: "pk_test_x", restricted_key: "${marker}" }');
      for (let i = 0; i < 40 && !keyWindow(); i++) await new Promise((r) => setTimeout(r, 250));
      const w = keyWindow();
      if (!w) return { opened: false, answer: await Promise.race([globalThis.__pending, new Promise((r) => setTimeout(() => r("no answer"), 5000))]) };
      await new Promise((r) => setTimeout(r, 1500));
      const prefs = w.webContents.getLastWebPreferences();
      const page = await w.webContents.executeJavaScript('({ scripts: document.scripts.length, require: typeof require, ipc: typeof ipcRenderer, fields: [...document.querySelectorAll("input")].map((i) => i.value) })');
      return { opened: true, modal: w.isModal(), protected: w.isContentProtected?.() ?? null, visible: w.isVisible(), prefs: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webviewTag: prefs.webviewTag }, page, appHasChannel: await inApp("typeof window.require === 'function' || typeof window.ipcRenderer !== 'undefined'") };
    `);
    check(opened.opened === true, "connecting Stripe from the page opens the key window");
    if (opened.opened !== true) throw new Error(`The app answered instead: ${JSON.stringify(opened.answer)}`);
    const prefs = opened.prefs as Record<string, boolean>;
    const page = opened.page as { scripts: number; require: string; ipc: string; fields: string[] };
    check(opened.modal === true && opened.visible === true, "it's shown, modal over the app");
    check(process.platform === "linux" || opened.protected === true, "it's left out of screenshots and screen sharing");
    check(prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false && prefs.webviewTag === false, "it's sandboxed and isolated, without Node or webviews");
    check(page.scripts === 0 && page.require === "undefined" && page.ipc === "undefined", "its page runs no script and reaches neither Node nor IPC");
    check(page.fields.every((value) => value === ""), "keys the app's page passed are ignored: its fields start empty");
    check(opened.appHasChannel === false, "the app's page has no way to the key window's channel");

    console.log("Trying to get past it:");
    const probe = await inMain<Record<string, unknown>>(`${WINDOWS}
      return keyWindow().webContents.executeJavaScript(\`(async () => {
        const out = {};
        window.__ran = false;
        const script = document.createElement("script");
        script.textContent = "window.__ran = true";
        document.body.append(script);
        await new Promise((r) => setTimeout(r, 200));
        out.injected = window.__ran;
        try { await fetch("https://example.com/"); out.fetch = "allowed"; } catch { out.fetch = "blocked"; }
        out.popup = window.open("https://example.com/") === null ? "denied" : "opened";
        const before = location.href;
        location.href = "https://example.com/";
        await new Promise((r) => setTimeout(r, 800));
        out.stayed = location.href === before;
        return out;
      })()\`);
    `);
    check(probe.injected === false, "an injected script doesn't run");
    check(probe.fetch === "blocked", "a request out is blocked");
    check(probe.popup === "denied", "a popup is denied");
    check(probe.stayed === true, "navigating away is refused");

    console.log("Keys typed there:");
    const typed = await inMain<{ answer: unknown; windows: number }>(`${WINDOWS}
      await keyWindow().webContents.executeJavaScript(\`(() => {
        for (const [name, value] of [["publishable_key", "pk_test_securitycheck"], ["restricted_key", "${marker}"]]) {
          const input = document.querySelector("input[name=" + name + "]");
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        document.getElementById("keys").requestSubmit();
      })()\`);
      const answer = await globalThis.__pending;
      return { answer, windows: BrowserWindow.getAllWindows().length };
    `);
    const answer = typed.answer as { error?: string };
    check(typeof answer.error === "string" && answer.error.includes("weren't accepted"), "reach the agent, whose processor's refusal comes back to the app");
    check(typed.windows === 1, "and the window closes");

    console.log("Changing one's mind:");
    const minds = await inMain<Record<string, unknown>>(`${WINDOWS}
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // The request under way, wrapped: awaiting it bare would wait for the
      // window to be answered.
      const opened = async () => { const pending = connect('"Stripe"'); for (let i = 0; i < 40 && !keyWindow(); i++) await wait(250); await wait(800); return { pending }; };
      const out = {};
      let { pending } = await opened();
      out.second = await connect('"Stripe"');
      out.windowsWithSecond = BrowserWindow.getAllWindows().length;
      await keyWindow().webContents.executeJavaScript('document.getElementById("cancel").click()');
      out.cancelled = await pending;
      ({ pending } = await opened());
      await keyWindow().webContents.executeJavaScript('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
      out.escaped = await pending;
      ({ pending } = await opened());
      keyWindow().close();
      out.closed = await pending;
      out.status = await inApp("window.__HANDSHAKE_PAYMENTS__.status()");
      return out;
    `);
    const nothing = (value: unknown) => JSON.stringify(value) === JSON.stringify({ done: null });
    check(nothing(minds.second) && minds.windowsWithSecond === 2, "a second request while it's open opens no second window");
    check(nothing(minds.cancelled) && nothing(minds.escaped) && nothing(minds.closed), "cancel, Escape and closing it change nothing");
    check(minds.status === null, "and nothing was connected");
  } catch (err) {
    failures.push(String(err));
    console.error(err);
  } finally {
    await inMain(`setTimeout(() => electron.app.quit(), 100); return true;`).catch(() => undefined);
    await exitsWithin(launched.exited, 60_000);
    await stop(launched.child, launched.exited, copy.root);
    copy.remove();
  }

  console.log("What's left behind:");
  const leaked = [...files(userData), ...files(logs)].filter((file) => {
    try {
      return readFileSync(file).includes("securitycheck");
    } catch {
      return false;
    }
  });
  check(leaked.length === 0, `no key typed appears anywhere in the profile or its logs${leaked.length ? `: ${leaked.join(", ")}` : ""}`);
  rmSync(userData, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nEvery check passed.");
}

await main();
