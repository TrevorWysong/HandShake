// The app's four payment commands (`window.__HANDSHAKE_PAYMENTS__`), passed
// to the main process's agent (desktop/payments.ts) -- added to Kangaroo's
// hApp preload by build.ts. Errors reach the app in the agent's own words.
// Connecting names only the processor: its keys are typed in a window of the
// main process's own (desktop/paymentKeys.ts), never in the app's pages.
// Each request says the page's language, for what that window and the
// main process's dialogs say.
const paymentsCall = async (command: string, ...args: unknown[]) => {
  try {
    return await ipcRenderer.invoke('handshake-payments', command, ...args);
  } catch (err) {
    throw new Error(String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''));
  }
};

contextBridge.exposeInMainWorld('__HANDSHAKE_PAYMENTS__', {
  keyEntry: 'runtime',
  status: () => paymentsCall('status'),
  connect: (processor: string) => paymentsCall('connect', processor, document.documentElement.lang),
  disconnect: () => paymentsCall('disconnect', document.documentElement.lang),
  wake: () => void paymentsCall('wake').catch(() => {}),
});
