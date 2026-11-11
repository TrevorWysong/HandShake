// Getting paid by card (docs/DIRECT_PAYMENTS.md) needs the payee's own
// processor keys, which the UI never touches. The runtime hosting the app
// runs a payment agent that keeps them in the device's keystore and carries
// out what the network says is due -- holds, captures, voids -- and hands the
// UI four commands, as `window.__HANDSHAKE_PAYMENTS__`:
//
//   status()                  what's connected: the processor, its account,
//                             live or test, and a payment it couldn't carry
//                             out lately (only its kind) -- or nothing
//   connect(processor)        asks for the processor's keys in a window of
//                             the runtime's own, which no page can see,
//                             checks them with the processor, keeps them,
//                             and publishes the public half as this agent's
//                             payment profile
//   disconnect()              forgets the keys and withdraws the profile
//   wake()                    looks for payments due now, not at its next poll
//
// None of them take an amount or name a payment: script in the UI can only
// ask the agent to do what the network already says is due. And no key
// passes through the UI: only the dev host, with test keys, takes them from
// the page (`keyEntry`). A runtime
// without an agent leaves it undefined; the app then can't take payments.
// In development the dev host stands in for the runtime (`devPayments.ts`).
import type { Processor } from "./types";
import { HOST } from "./host";

export interface PaymentsConnection {
  processor: Processor;
  /// The processor's name for the account, as its dashboard shows it.
  account: string;
  live: boolean;
  /// A payment due that it couldn't carry out, until a round goes cleanly:
  /// its kind and when (ms). Not the processor's words: those are in its
  /// own dashboard.
  trouble: { what: string; at: number } | null;
}

export interface PaymentsAgent {
  /// Where a processor's keys are typed: in a window of the runtime's own
  /// ("runtime"), or -- the dev host only -- in the page, passed to `connect`.
  keyEntry: "runtime" | "page";
  status(): Promise<PaymentsConnection | null>;
  /// `null` when the person closes the runtime's key window instead.
  connect(processor: Processor, keys?: Record<string, string>): Promise<PaymentsConnection | null>;
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
