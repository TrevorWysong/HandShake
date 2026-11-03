// Getting paid by card (docs/DIRECT_PAYMENTS.md) needs the payee's own
// processor keys, which the UI never touches. The runtime hosting the app
// runs a payment agent that keeps them in the device's keystore and carries
// out what the network says is due -- holds, captures, voids -- and hands the
// UI four commands, as `window.__HANDSHAKE_PAYMENTS__`:
//
//   status()                  what's connected: the processor, its account,
//                             live or test -- or nothing
//   connect(processor, keys)  checks the keys with the processor, keeps them,
//                             and publishes the public half as this agent's
//                             payment profile
//   disconnect()              forgets the keys and withdraws the profile
//   wake()                    looks for payments due now, not at its next poll
//
// None of them take an amount or name a payment: script in the UI can only
// ask the agent to do what the network already says is due. A runtime
// without an agent leaves it undefined; the app then can't take payments.
// In development the dev host stands in for the runtime (`devPayments.ts`).
import type { Processor } from "./types";
import { HOST } from "./host";

export interface PaymentsConnection {
  processor: Processor;
  /// The processor's name for the account, as its dashboard shows it.
  account: string;
  live: boolean;
}

export interface PaymentsAgent {
  status(): Promise<PaymentsConnection | null>;
  connect(processor: Processor, keys: Record<string, string>): Promise<PaymentsConnection>;
  disconnect(): Promise<void>;
  wake(): void;
}

declare global {
  interface Window {
    __HANDSHAKE_PAYMENTS__?: PaymentsAgent;
  }
}

/// The runtime's payment agent, where there is one.
export async function paymentsAgent(): Promise<PaymentsAgent | null> {
  if (HOST === "launcher") return window.__HANDSHAKE_PAYMENTS__ ?? null;
  if (__DEV_HOST__ && HOST === "dev") return (await import("./devPayments")).devPayments();
  return null;
}
