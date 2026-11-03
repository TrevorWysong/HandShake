// A payment agent (payments/) for an identity on the dev conductor, as the
// desktop app runs one for its own: its processor keys and its state kept
// under .dev/payments/<app>/, readable by their owner only, and woken by
// the network's signals. Used by the seed and by `npm run dev:payments`.
import path from "node:path";
import { AppWebsocket, type AdminWebsocket } from "@holochain/client";
import { createAgent, type Agent } from "../../../payments/src/agent.ts";
import { processorFor } from "../../../payments/src/adapters/index.ts";
import { fileCredentials } from "../../../payments/src/credentials.ts";
import { fileStore } from "../../../payments/src/state.ts";
import { DEV_DIR, ROLE_NAME, WS_OPTIONS, appInterfacePort, closeApp, messageOf } from "./devEnv.ts";

export const PAYMENTS_DIR = path.join(DEV_DIR, "payments");

export interface DevPaymentsAgent {
  agent: Agent;
  close: () => Promise<unknown>;
}

/// The payment agent for the conductor's app `appId`, started.
export async function devPaymentsAgent(adminWs: AdminWebsocket, appId: string, log: (line: string) => void = () => {}): Promise<DevPaymentsAgent> {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(appId)) throw new Error("not an app id");
  const app = (await adminWs.listApps({})).find((a) => a.installed_app_id === appId);
  const cell = app?.cell_info[ROLE_NAME]?.[0];
  if (!cell || cell.type !== "provisioned") throw new Error(`${appId} has no ${ROLE_NAME} cell`);
  const cellId = cell.value.cell_id;
  await adminWs.authorizeSigningCredentials(cellId);
  const { token } = await adminWs.issueAppAuthenticationToken({ installed_app_id: appId });
  const appWs = await AppWebsocket.connect({ url: new URL(`ws://localhost:${await appInterfacePort(adminWs)}`), token, wsClientOptions: WS_OPTIONS, defaultTimeout: 60_000 });
  const dir = path.join(PAYMENTS_DIR, appId);
  const agent = createAgent({
    dispatch: (fn, payload) => appWs.callZome({ cell_id: cellId, zome_name: "dispatch", fn_name: fn, payload }),
    credentials: fileCredentials(path.join(dir, "keys.json")),
    state: fileStore(path.join(dir, "state.json")),
    processorFor,
    onProblem: (what, err) => log(`${appId}: ${what}: ${messageOf(err)}`),
  });
  // The network's word that something changed: a payment offered, an
  // order moved on.
  appWs.on("signal", () => agent.wake());
  await agent.start();
  return {
    agent,
    close: async () => {
      agent.stop();
      await closeApp(appWs);
    },
  };
}
