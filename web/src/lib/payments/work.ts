// Proof of work for a payee seeing cards tested (dispatch's `PayeeBusy`):
// while it is, a payer with no record does a moment's work with their card,
// so testing cards across throwaway accounts costs that work again for every
// one, and a real newcomer is never turned away for it. The zome checks the
// same hash (`dispatch_types::work_bits`).
import { blake2b } from "@noble/hashes/blake2b";
import { callZome, myAgentPubKey } from "../../holochain/client";
import type { ActionHash, AgentPubKey, PaymentInput, PaymentLeg, WorkAsked, WorkProof } from "../../holochain/types";

const PREFIX = new TextEncoder().encode("handshake-work:v1:");
/// Tries between yields to the page, so it stays responsive while working.
const TRIES_PER_YIELD = 4_096;

/// How many zero bits `hash` starts with.
export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/// The hash a nonce is tried by: who's paying whom, for which busy record.
export function workHash(payer: AgentPubKey, payee: AgentPubKey, busy: ActionHash, nonce: number): Uint8Array {
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(nonce), true);
  const bytes = new Uint8Array(PREFIX.length + payer.length + payee.length + busy.length + counter.length);
  let at = 0;
  for (const part of [PREFIX, payer, payee, busy, counter]) {
    bytes.set(part, at);
    at += part.length;
  }
  return blake2b(bytes, { dkLen: 32 });
}

/// A nonce proving `asked.bits` of work for its payee's busy record.
export async function findWork(payer: AgentPubKey, asked: WorkAsked): Promise<WorkProof> {
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(workHash(payer, asked.payee, asked.busy, nonce)) >= asked.bits) return { busy: asked.busy, nonce };
    if (nonce % TRIES_PER_YIELD === TRIES_PER_YIELD - 1) await new Promise((done) => setTimeout(done, 0));
  }
}

/// `payment`, with the work its payee asks of the caller, if it asks any.
async function withWork(asked: WorkAsked | null, payment: PaymentInput): Promise<PaymentInput> {
  return asked ? { ...payment, work: await findWork(myAgentPubKey(), asked) } : payment;
}

/// `payment`, ready for `payee`: with the work it asks of the caller, if any.
export async function workedFor(payee: AgentPubKey, payment: PaymentInput): Promise<PaymentInput> {
  return withWork(await callZome<WorkAsked | null>("dispatch", "work_needed", payee), payment);
}

/// `workedFor`, for a leg of an order already placed.
export async function workedForLeg(order: ActionHash, leg: PaymentLeg, payment: PaymentInput): Promise<PaymentInput> {
  return withWork(await callZome<WorkAsked | null>("dispatch", "work_needed_for_leg", { order, leg }), payment);
}
