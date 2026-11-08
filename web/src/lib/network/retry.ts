// Trying again, for a step that waits on something to reach this device:
// a record just written on someone else's chain, a conductor coming back.

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/// Runs `work`, and again after each of `delaysMs` while it fails in a way
/// `retryable` allows. The last failure is thrown.
export async function retrying<T>(work: () => Promise<T>, delaysMs: readonly number[], retryable: (err: unknown) => boolean = () => true): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (attempt >= delaysMs.length || !retryable(err)) throw err;
      await wait(delaysMs[attempt]);
    }
  }
}
