// The desktop app's payment agent (payments/), in Electron's main process --
// copied into Kangaroo's src/main by build.ts, and started by its launch
// once the conductor and the app's window are up. It keeps the payee's
// processor keys sealed with the operating system's keystore (Electron
// `safeStorage`), outside the app's pages, and answers four commands from
// the app's own window only (`window.__HANDSHAKE_PAYMENTS__`, exposed by the
// preload patch): status, connect, disconnect, wake. None takes an amount.
import path from 'path';
import { BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { AppWebsocket, CellType } from '@holochain/client';
import { createAgent } from './payments/src/agent.ts';
import { processorFor } from './payments/src/adapters/index.ts';
import { fileCredentials, type Sealer } from './payments/src/credentials.ts';
import { Refused } from './payments/src/processor.ts';
import { fileStore } from './payments/src/state.ts';
import type { HolochainManager } from './holochainManager';
import type { KangarooFileSystem } from './filesystem';
import { HAPP_APP_ID } from './const';

/// The app's DNA role, as its hApp names it.
const ROLE_NAME = 'handshake';
/// The origin the agent's websocket presents to its own app interface.
const AGENT_ORIGIN = 'handshake-payments';

/// The keystore's seal: refuses to keep keys where there's no keystore.
const sealer: Sealer = {
  async seal(plain) {
    // On Linux without a keyring, Electron "encrypts" with a fixed key: not
    // a keystore at all.
    const plainText = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
    if (!safeStorage.isEncryptionAvailable() || plainText) throw new Refused("This computer has no keystore to keep your processor's keys in.");
    return safeStorage.encryptString(plain);
  },
  async open(sealed) {
    return safeStorage.decryptString(sealed);
  },
};

/// Starts the agent beside the app, never in its way: the app's window is
/// already up and waiting to sign its calls, which a slow or failed start here
/// mustn't hold back. Until the agent's up its commands wait for it, and if it
/// can't start they say so.
export function startPayments(holochain: HolochainManager, window: BrowserWindow, fs: KangarooFileSystem): void {
  const started = startAgent(holochain, window, fs);
  started.catch((err) => console.error(`[payments] didn't start: ${err instanceof Error ? err.stack : String(err)}`));

  // Only the app's own page, in its own window -- never a frame inside it.
  const fromTheApp = (event: IpcMainInvokeEvent) => !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  ipcMain.handle('handshake-payments', async (event, command: unknown, ...args: unknown[]) => {
    if (!fromTheApp(event)) throw new Error('Not allowed.');
    const agent = await started;
    switch (command) {
      case 'status':
        return agent.status();
      case 'connect':
        return agent.connect(args[0], args[1]);
      case 'disconnect':
        return agent.disconnect();
      case 'wake':
        return agent.wake();
      default:
        throw new Error('No such command.');
    }
  });
}

async function startAgent(holochain: HolochainManager, window: BrowserWindow, fs: KangarooFileSystem) {
  const admin = holochain.adminWebsocket;
  const app = (await admin.listApps({})).find((a) => a.installed_app_id === HAPP_APP_ID);
  const cell = app?.cell_info[ROLE_NAME]?.find((c) => c.type === CellType.Provisioned);
  if (!cell || cell.type !== CellType.Provisioned) throw new Error(`The app has no ${ROLE_NAME} cell.`);
  const cellId = cell.value.cell_id;
  await admin.authorizeSigningCredentials(cellId);
  const { token } = await admin.issueAppAuthenticationToken({ installed_app_id: HAPP_APP_ID });
  // Its own app interface, for this app and this origin only -- the app's
  // window keeps Kangaroo's -- reused across restarts.
  const existing = (await admin.listAppInterfaces()).find((i) => i.allowed_origins === AGENT_ORIGIN && i.installed_app_id === HAPP_APP_ID);
  const port = existing?.port ?? (await admin.attachAppInterface({ allowed_origins: AGENT_ORIGIN, installed_app_id: HAPP_APP_ID })).port;
  const appWs = await AppWebsocket.connect({ url: new URL(`ws://localhost:${port}`), token, wsClientOptions: { origin: AGENT_ORIGIN } });

  // Per identity: one this install signs in as later -- an account restored
  // or moved here -- never acts with another's processor keys or cards.
  const dir = path.join(fs.profileDataDir, 'payments', Buffer.from(cellId[1]).toString('hex'));
  const agent = createAgent({
    dispatch: (fn, payload) => appWs.callZome({ cell_id: cellId, zome_name: 'dispatch', fn_name: fn, payload }),
    credentials: fileCredentials(path.join(dir, 'keys.sealed'), sealer),
    state: fileStore(path.join(dir, 'state.json')),
    processorFor,
    // The person's own yes, in a dialog the app's pages can't draw or click.
    confirm: async (change) => {
      const { response } = await dialog.showMessageBox(window, change
        ? { type: 'question', buttons: ['Connect', 'Cancel'], defaultId: 1, cancelId: 1, message: `Get paid into this ${change.processor} account?`, detail: `${change.connection.account} (${change.connection.live ? 'live' : 'test mode'}). Customers' and stores' cards will be held and charged for you on it.` }
        : { type: 'warning', buttons: ['Disconnect', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Stop taking card payments here?', detail: 'Payments already held are charged once you connect again; until then nobody can pay you by card.' });
      return response === 0;
    },
    onProblem: (what, err) => console.warn(`[payments] ${what}: ${err instanceof Error ? err.message : String(err)}`),
  });
  appWs.on('signal', () => agent.wake());
  await agent.start();
  return agent;
}
