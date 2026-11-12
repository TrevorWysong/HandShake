// The adapter for each processor a payee can connect.
import { Refused, type Processor } from "../processor.ts";
import type { ProcessorName } from "../types.ts";
import { cloverProcessor, type CloverKeys } from "./clover.ts";
import { squareProcessor, type SquareKeys } from "./square.ts";
import { stripeProcessor, type StripeKeys } from "./stripe.ts";
import { testProcessor } from "./test.ts";

/// The keys each processor needs, by name -- what the app's form asks for.
export const KEY_NAMES: Record<ProcessorName, readonly string[]> = {
  Stripe: ["publishable_key", "restricted_key"],
  Square: ["application_id", "location_id", "access_token"],
  Clover: ["merchant_id", "public_key", "private_token"],
  Test: [],
};

/// Each processor, and when its adapter was run end to end against the
/// processor's own sandbox (docs/DIRECT_PAYMENTS.md) -- `null` until it has.
/// Only one that has takes real money: one that hasn't can be connected on
/// a network for testing, to run it there, and nowhere else.
export const VERIFIED: Record<ProcessorName, string | null> = {
  Stripe: "2026-11-03",
  Square: null,
  Clover: null,
  Test: null,
};

export function processorFor(name: ProcessorName, keys: Record<string, string>, currency: string): Processor {
  const missing = KEY_NAMES[name].filter((field) => !keys[field]);
  if (missing.length > 0) throw new Refused("Fill in every key your processor's dashboard gives you.");
  switch (name) {
    case "Stripe":
      return stripeProcessor(keys as unknown as StripeKeys, currency);
    case "Square":
      return squareProcessor(keys as unknown as SquareKeys, currency);
    case "Clover":
      return cloverProcessor(keys as unknown as CloverKeys, currency);
    case "Test":
      return testProcessor(currency);
  }
}
