// The payment agent, whole: the processor keys it keeps, the rounds it
// runs, and the four commands it gives the app (`window.__HANDSHAKE_PAYMENTS__`,
// web/src/holochain/paymentsAgent.ts) -- status, connect, disconnect, wake.
// None of them takes an amount or names a payment: whatever runs in the
// app's pages can at most ask to connect an account (with keys it was
// given), or ask the agent to look for what the network says is due now.
// Connecting or disconnecting waits for the person's own yes, asked outside
// the app's pages (`confirm`), so no script in them can point payments at
// another account.
import { Engine, type Dispatch } from "./engine.ts";
import { KEY_NAMES } from "./adapters/index.ts";
import type { CredentialStore } from "./credentials.ts";
import type { Connection, Processor } from "./processor.ts";
import { Refused, accountId } from "./processor.ts";
import type { StateStore } from "./state.ts";
import type { NetworkTerms, ProcessorName } from "./types.ts";

/// How often the agent looks for payments due, between the network's
/// signals waking it.
const ROUND_MS = 20_000;

export interface Status {
  processor: ProcessorName;
  account: string;
  live: boolean;
  /// The last round that couldn't carry out a payment due, if no round
  /// has gone cleanly since: what kind (`Authorize`, `Settle`, `Refund`,
  /// `Forget`, or `round` for the round itself), and when (ms). Never the
  /// processor's own words -- they're the payee's to read in its dashboard,
  /// not the app's pages'.
  trouble: { what: string; at: number } | null;
}

export interface AgentOptions {
  dispatch: Dispatch;
  credentials: CredentialStore;
  state: StateStore;
  /// The adapter for a processor, with its keys.
  processorFor: (processor: ProcessorName, keys: Record<string, string>, currency: string) => Processor;
  /// Asks the person, outside the app's pages, whether to connect the
  /// account found (`connection`) -- or, with none, to disconnect.
  confirm: (change: { processor: ProcessorName; connection: Connection } | null) => Promise<boolean>;
  roundMs?: number;
  onProblem?: (what: string, err: unknown) => void;
}

/// What the app may pass as keys: the processor's own fields, each a
/// short string.
export function checkKeysInput(processor: unknown, keys: unknown): { processor: ProcessorName; keys: Record<string, string> } {
  if (typeof processor !== "string" || !Object.hasOwn(KEY_NAMES, processor)) throw new Refused("That isn't a processor HandShake works with.");
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) throw new Refused("Those keys aren't in a form HandShake reads.");
  const names = KEY_NAMES[processor as ProcessorName];
  const entries = Object.entries(keys);
  if (entries.some(([name, value]) => !names.includes(name) || typeof value !== "string" || value.length > 500)) {
    throw new Refused("Those keys aren't in a form HandShake reads.");
  }
  return { processor: processor as ProcessorName, keys: Object.fromEntries(entries.map(([name, value]) => [name, (value as string).trim()])) };
}

export function createAgent(options: AgentOptions) {
  const { dispatch, credentials, state, processorFor, confirm, roundMs = ROUND_MS, onProblem: report = () => {} } = options;
  let engine: Engine | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  // What last went wrong, kept until a round goes cleanly. Each round is
  // judged on its own: a wake asked for mid-round joins that round (the
  // engine runs one at a time), so it shares its verdict rather than
  // resetting it.
  let trouble: Status["trouble"] = null;
  let current: { done: Promise<number>; troubled: boolean } | null = null;
  const onProblem = (what: string, err: unknown) => {
    if (current) current.troubled = true;
    trouble = { what, at: Date.now() };
    report(what, err);
  };
  const terms = () => dispatch<NetworkTerms>("get_network_terms", null);
  /// A round, its trouble noted -- or cleared, when it went cleanly.
  async function rounded(): Promise<number> {
    if (!engine) return 0;
    if (!current) {
      const pass = { done: Promise.resolve(0), troubled: false };
      pass.done = engine.round().finally(() => {
        if (current === pass) current = null;
      });
      current = pass;
    }
    const pass = current;
    const done = await pass.done;
    if (!pass.troubled) trouble = null;
    return done;
  }
  const round = () => void rounded().catch((err) => onProblem("round", err));

  async function run(processor: ProcessorName, keys: Record<string, string>, connection: Connection) {
    const { currency } = await terms();
    const account = accountId(processor, connection);
    await adopt(account);
    engine = new Engine({ dispatch, processor: processorFor(processor, keys, currency), state, currency, account, onProblem });
    round();
  }

  /// Makes `account` the one this agent's state is for. Cards saved with
  /// another, and bank challenges begun there, can't be used with it, so
  /// they're dropped: their payers enter a card again. Holds placed there
  /// stay theirs (`State.heldWith`), settled when it's connected again.
  async function adopt(account: string) {
    const kept = await state.load();
    if (kept.account === account) return;
    // Kept before accounts were told apart: they're this one's.
    if (kept.account !== null) Object.assign(kept, { saved: {}, savedAt: {}, challenged: {} });
    kept.account = account;
    await state.save(kept);
  }

  return {
    /// Starts rounds with the keys already kept, if any.
    async start() {
      const kept = await credentials.load();
      if (kept) await run(kept.processor, kept.keys, kept.connection);
      timer ??= setInterval(round, roundMs);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    async status(): Promise<Status | null> {
      const kept = await credentials.load();
      return kept && { processor: kept.processor, account: kept.connection.account, live: kept.connection.live, trouble };
    },

    /// Checks the keys with the processor, keeps them, and publishes their
    /// public half as this agent's payment profile.
    async connect(processorInput: unknown, keysInput: unknown): Promise<Status> {
      const { processor, keys } = checkKeysInput(processorInput, keysInput);
      // Clover's online charges must carry the IP address of the payer's
      // browser, which a payee's device never sees, so every charge would
      // fail. Not taken until it can be done without sending the payer's
      // address to their store.
      if (processor === "Clover") throw new Refused("Clover can't be connected yet. Use Stripe or Square for now.");
      const network = await terms();
      if (processor === "Test" && network.live_payments) throw new Refused("This network takes real payments: connect a live processor account.");
      const connection = await processorFor(processor, keys, network.currency).connect();
      if (connection.live !== network.live_payments) {
        if (network.live_payments) throw new Refused("This network takes real payments: use your account's live keys.");
        throw new Refused("This network is for testing: use your account's test keys.");
      }
      if (connection.currency.toUpperCase() !== network.currency.toUpperCase()) throw new Refused(`That account takes ${connection.currency.toUpperCase()}; this network pays in ${network.currency.toUpperCase()}.`);
      if (!(await confirm({ processor, connection }))) throw new Refused("Not connected: you didn't confirm it.");
      await dispatch("set_payment_profile", { processor, public_key: connection.publicKey, account: connection.publicAccount, live: connection.live, country: connection.country });
      await credentials.save({ processor, keys, connection });
      trouble = null;
      await run(processor, keys, connection);
      return { processor, account: connection.account, live: connection.live, trouble: null };
    },

    /// Withdraws the payment profile and forgets the keys. Payments already
    /// held settle once it's connected again.
    async disconnect() {
      if (!(await confirm(null))) throw new Refused("Still connected: you didn't confirm it.");
      await dispatch("clear_payment_profile", null);
      await credentials.clear();
      engine = null;
      trouble = null;
    },

    /// Looks for payments due now, not at the next round.
    wake() {
      round();
    },

    /// A round, awaited: how many payments it carried out.
    async round(): Promise<number> {
      return rounded();
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
