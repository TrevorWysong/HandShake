// The app's four payment commands (`window.__HANDSHAKE_PAYMENTS__`), passed
// to the main process's agent (desktop/payments.ts) -- added to Kangaroo's
// hApp preload by build.ts. Errors reach the app in the agent's own words.
const paymentsCall = async (command: string, ...args: unknown[]) => {
  try {
    return await ipcRenderer.invoke('handshake-payments', command, ...args);
  } catch (err) {
    throw new Error(String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''));
  }
};

contextBridge.exposeInMainWorld('__HANDSHAKE_PAYMENTS__', {
  status: () => paymentsCall('status'),
  connect: (processor: string, keys: Record<string, string>) => paymentsCall('connect', processor, keys),
  disconnect: () => paymentsCall('disconnect'),
  wake: () => void paymentsCall('wake').catch(() => {}),
});
