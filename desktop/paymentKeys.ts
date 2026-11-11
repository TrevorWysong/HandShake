// Processor keys, typed where the app's pages can't reach them: a window of
// the main process's own, opened over the app's when a store or driver
// connects Stripe or Square (desktop/payments.ts). The keys go from it to
// the payment agent and nowhere else, so script in the app's pages -- an
// injected one, or a dependency gone bad -- never holds a key.
//
// The window is as closed as Electron allows: sandboxed, isolated, in a
// session of its own that keeps nothing and grants nothing, refusing every
// request but its own page, every navigation and every popup, and left out
// of screenshots. Its page has no script at all; its preload draws the form
// and is the only thing that speaks to this module, on one channel, from
// that window only.
import path from 'path';
import { pathToFileURL } from 'url';
import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import { is } from '@electron-toolkit/utils';
import { KEY_CHANNEL, keyForm, type KeyAnswer, type KeyedProcessor, type KeyForm, type Locale } from './paymentKeyForm';

/// In memory only: nothing the window loads is kept.
const SESSION = 'handshake-payment-keys';
const PAGE = 'paymentKeys.html';
const WIDTH = 460;

/// The window open now, if one is: one at a time.
let open: { window: BrowserWindow; form: KeyForm; answer: (answer: KeyAnswer) => void } | null = null;

/// Takes the key window's requests -- once, when the payment agent starts.
export function openKeyChannel(): void {
  lockSession();
  ipcMain.handle(KEY_CHANNEL, (event, command: unknown, payload: unknown) => {
    const current = open;
    if (!current || !fromWindow(event, current.window)) throw new Error('Not allowed.');
    if (command === 'form') return current.form;
    if (command === 'fit') return fit(current.window, payload);
    if (command === 'answer') return current.answer(answerOf(payload, current.form));
    throw new Error('No such command.');
  });
}

/// Asks for `processor`'s keys in the key window, over `parent`, and hands
/// them to `use` -- whose answer this is -- or `null` if the person closes
/// it. The window stays up, saying it's checking, while `use` runs, so the
/// agent's own confirmation opens over it; it closes once `use` is done,
/// whatever the outcome, and the app's page says what came of it.
export async function withKeys<T>(parent: BrowserWindow, processor: KeyedProcessor, locale: Locale, use: (keys: Record<string, string>) => Promise<T>): Promise<T | null> {
  if (open) {
    open.window.focus();
    return null;
  }
  const form = keyForm(processor, locale);
  const window = keyWindow(parent, form);
  const answered = new Promise<KeyAnswer>((answer) => {
    open = { window, form, answer };
    window.once('closed', () => answer({ cancel: true }));
  });
  try {
    await window.loadURL(pageUrl());
    const answer = await answered;
    return 'cancel' in answer ? null : await use(answer.keys);
  } finally {
    open = null;
    if (!window.isDestroyed()) window.destroy();
  }
}

function keyWindow(parent: BrowserWindow, form: KeyForm): BrowserWindow {
  const window = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    title: form.title,
    width: WIDTH,
    height: 420,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#fbf8f4',
    webPreferences: {
      preload: path.join(__dirname, '../preload/paymentKeys.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
      partition: SESSION,
    },
  });
  window.setMenu(null);
  // Out of screenshots and screen sharing, where a key could be read off.
  window.setContentProtection(true);
  const page = window.webContents;
  page.on('will-navigate', (event) => event.preventDefault());
  page.on('will-redirect', (event) => event.preventDefault());
  page.on('will-attach-webview', (event) => event.preventDefault());
  page.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Shown once its page has fitted it to the form (`fit`) -- or soon after
  // it's drawn regardless, so it never stays hidden.
  window.once('ready-to-show', () => setTimeout(() => window.isDestroyed() || window.show(), 1000));
  return window;
}

/// Sizes the window to its form, `height` tall -- within reason, whatever the
/// page says -- and shows it.
function fit(window: BrowserWindow, height: unknown): void {
  if (typeof height === 'number' && Number.isFinite(height)) window.setContentSize(WIDTH, Math.min(Math.max(Math.ceil(height), 240), 720));
  window.show();
}

/// The window's page: from the dev server while developing, else the file
/// built beside the app's other screens.
function pageUrl(): string {
  const dev = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined;
  return dev ? `${dev}/${PAGE}` : pathToFileURL(path.join(__dirname, '../renderer', PAGE)).href;
}

/// The window's session grants nothing and loads nothing but its page.
function lockSession(): void {
  const keys = session.fromPartition(SESSION);
  keys.setPermissionRequestHandler((_page, _permission, grant) => grant(false));
  keys.setPermissionCheckHandler(() => false);
  keys.webRequest.onBeforeRequest((request, decide) => decide({ cancel: request.url !== pageUrl() }));
}

/// Only the key window's own page, never a frame in it.
function fromWindow(event: IpcMainInvokeEvent, window: BrowserWindow): boolean {
  return !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

/// The page's answer, as untrusted as anything a page sends: the form's own
/// fields, each a short string, or nothing at all.
function answerOf(payload: unknown, form: KeyForm): KeyAnswer {
  if (typeof payload !== 'object' || payload === null || !('keys' in payload)) return { cancel: true };
  const keys = (payload as { keys: unknown }).keys;
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return { cancel: true };
  const given = Object.entries(keys);
  const names = form.fields.map((field) => field.name);
  const fits = given.length === names.length && given.every(([name, value]) => names.includes(name) && typeof value === 'string' && value.length <= 500);
  return fits ? { keys: Object.fromEntries(given) as Record<string, string> } : { cancel: true };
}
