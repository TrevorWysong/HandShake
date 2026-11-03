// The dev host's payment agents (`npm run dev:payments`), standing in for
// the desktop app's: one for each identity on the dev conductor that has
// connected a processor, plus any the app asks for, each doing what the
// network says is due -- on the test processor, or on a processor's
// sandbox with keys pasted into the app.
//
// The app reaches them as it would the desktop app's
// (`window.__HANDSHAKE_PAYMENTS__`): `devPayments.ts` posts the four commands
// here. Only from this machine, only with the token this run writes to
// web/public/dev-payments.json (git-ignored), only from the dev server's
// own origin.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { REPO, connectAdmin, messageOf } from "./lib/devEnv.ts";
import { PAYMENTS_DIR, devPaymentsAgent, type DevPaymentsAgent } from "./lib/payments.ts";

const PORT = Number(process.env.HANDSHAKE_PAYMENTS_PORT ?? 8872);
const CONFIG = path.join(REPO, "web/public/dev-payments.json");
const token = randomBytes(32).toString("hex");
const MAX_BODY = 8 * 1024;

const adminWs = await connectAdmin();
const agents = new Map<string, Promise<DevPaymentsAgent>>();
const log = (line: string) => console.log(`[payments] ${line}`);
const agentFor = (app: string) => {
  let running = agents.get(app);
  if (!running) {
    running = devPaymentsAgent(adminWs, app, log);
    running.catch(() => agents.delete(app));
    agents.set(app, running);
  }
  return running;
};

// Every identity that connected a processor before, running again.
let kept: string[] = [];
try {
  kept = readdirSync(PAYMENTS_DIR);
} catch {
  // none yet
}
const installed = new Set((await adminWs.listApps({})).map((a) => a.installed_app_id));
for (const app of kept.filter((a) => installed.has(a))) {
  await agentFor(app).then(
    () => log(`running for ${app}`),
    (err) => log(`couldn't start ${app}: ${messageOf(err)}`),
  );
}

const allowedOrigin = (origin: string | undefined) => !!origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
const authorized = (req: IncomingMessage) => {
  const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_BODY) throw new Error("too large");
  }
  return JSON.parse(text || "{}");
}

function reply(res: ServerResponse, origin: string, status: number, json: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", Vary: "Origin" });
  res.end(JSON.stringify(json));
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!allowedOrigin(origin)) return void res.writeHead(403).end();
  if (req.method === "OPTIONS") return reply(res, origin!, 204, null);
  if (req.method !== "POST" || !authorized(req)) return reply(res, origin!, 403, { error: "Not allowed." });
  try {
    const input = await body(req);
    const app = String(input.app ?? "");
    const { agent } = await agentFor(app);
    switch (req.url) {
      case "/status":
        return reply(res, origin!, 200, await agent.status());
      case "/connect":
        return reply(res, origin!, 200, await agent.connect(input.processor, input.keys));
      case "/disconnect":
        await agent.disconnect();
        return reply(res, origin!, 200, null);
      case "/wake":
        agent.wake();
        return reply(res, origin!, 200, null);
      default:
        return reply(res, origin!, 404, { error: "No such command." });
    }
  } catch (err) {
    return reply(res, origin!, 400, { error: messageOf(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  writeFileSync(CONFIG, `${JSON.stringify({ url: `http://127.0.0.1:${PORT}`, token })}\n`, { mode: 0o600 });
  log(`agents for the dev conductor's identities on 127.0.0.1:${PORT}`);
});

const stop = async () => {
  rmSync(CONFIG, { force: true });
  await Promise.allSettled([...agents.values()].map(async (a) => (await a).close()));
  await adminWs.client.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
