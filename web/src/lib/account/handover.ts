// The old phone taking its account back from a handover (docs/RECOVERY.md):
// the runtime asks the network, as the account itself and before anything
// writes (`take_back`). Its answer is one of three: taken
// back; refused for good, because the new phone has written as the account;
// or not yet -- the network hasn't caught up -- to try again. Only the
// second is final: a screen that took "not yet" for it would tell someone
// their new phone has an account it may never have received.
import type { DeviceRuntime } from "../../holochain/device";

/// Why a take-back didn't go through.
export type TakeBackRefusal = "tooLate" | "notYet";

/// A failed take-back, read from the zome's own words before translation.
export function takeBackRefusal(err: unknown): TakeBackRefusal {
  return /started using this account/.test(String(err)) ? "tooLate" : "notYet";
}

/// A take-back that didn't go through, and why.
export class TakeBackRefused extends Error {
  readonly refusal: TakeBackRefusal;
  override readonly cause: unknown;
  constructor(refusal: TakeBackRefusal, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.refusal = refusal;
    this.cause = cause;
  }
}

/// Takes the account back: resolves once it's this device's again, or
/// rejects with `TakeBackRefused`. Safe to try again after "not yet".
export async function takeAccountBack(runtime: Pick<DeviceRuntime, "stay">): Promise<void> {
  try {
    await runtime.stay();
  } catch (err) {
    throw new TakeBackRefused(takeBackRefusal(err), err);
  }
}
