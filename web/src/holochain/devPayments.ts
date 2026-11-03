// The dev host standing in for a runtime's payment agent
// (`paymentsAgent.ts`): `npm run dev:payments` runs one for each identity on
// the dev conductor, and this passes the four commands to the one for the
// identity signed in here. Loaded only when `DEV_HOST` holds.
import type { PaymentsAgent, PaymentsConnection } from "./paymentsAgent";
import { loadStoredIdentity } from "./devIdentityStorage";

/// Where this run of `dev:payments` listens, and its token.
async function host(): Promise<{ url: string; token: string } | null> {
  const response = await fetch("/dev-payments.json", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null);
}

async function command<T>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const found = await host();
  const identity = loadStoredIdentity();
  if (!found || !identity) throw new Error("Start the dev payment agents with `npm run dev:payments` in web/.");
  const response = await fetch(`${found.url}/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${found.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ app: identity.installedAppId, ...input }),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error ?? "The dev payment agent refused.");
  return json as T;
}

/// The dev agents, once `dev:payments` is running -- `null` until then.
export async function devPayments(): Promise<PaymentsAgent | null> {
  if (!(await host())) return null;
  return {
    status: () => command<PaymentsConnection | null>("status"),
    connect: (processor, keys) => command<PaymentsConnection>("connect", { processor, keys }),
    disconnect: () => command<void>("disconnect"),
    wake: () => void command("wake").catch(() => {}),
  };
}
