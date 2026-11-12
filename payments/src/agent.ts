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
import type { CredentialStore, Credentials } from "./credentials.ts";
import type { Connection, Processor } from "./processor.ts";
import { KeyRefused, Refused, accountId } from "./processor.ts";
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
  /// `Forget`, `Unreadable` for an order the network couldn't say what's
  /// due on, or `round` for the round itself), and when (ms). Never the
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

/// The public half of an account's keys, as the network publishes it.
const profileOf = (processor: ProcessorName, connection: Connection) => ({ processor, public_key: connection.publicKey, account: connection.publicAccount, live: connection.live, country: connection.country });

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

  // Rounds and changes of account take turns: a round begun with one
  // account's keys never saves its state over what a change made, and a
  // change waits for it to finish.
  let turn: Promise<unknown> = Promise.resolve();
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const mine = turn.then(work, work);
    turn = mine.catch(() => undefined);
    return mine;
  }

  /// A round, its trouble noted -- or cleared, when it went cleanly.
  async function rounded(): Promise<number> {
    if (!current) {
      const pass = { done: Promise.resolve(0), troubled: false };
      pass.done = inTurn(async () => (engine ? engine.round() : 0)).finally(() => {
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

  // Nothing is paid until the network's profile is known to match the keys
  // kept here (`reconcile`): until then there's no engine, and each tick
  // tries to put it right again rather than a round.
  let reconciled = false;
  let reconciling: Promise<void> | null = null;
  function begin(): Promise<void> {
    reconciling ??= (async () => {
      const kept = await credentials.load();
      await inTurn(() => reconcile(kept));
      if (kept) {
        const { currency } = await terms();
        await inTurn(() => use(kept.processor, kept.keys, kept.connection, currency));
      }
      reconciled = true;
    })().finally(() => (reconciling = null));
    return reconciling;
  }
  const tick = () => {
    if (reconciled) return round();
    begin().then(round, (err) => onProblem("round", err));
  };

  /// Runs `processor`'s account from now on. Called in turn.
  async function use(processor: ProcessorName, keys: Record<string, string>, connection: Connection, currency: string) {
    const account = accountId(processor, connection);
    await adopt(account);
    engine = new Engine({ dispatch, processor: processorFor(processor, keys, currency), state, currency, account, onProblem });
  }

  /// Makes `account` the one this agent's state is for. Cards saved with
  /// another, and bank challenges begun there, can't be used with it, so
  /// they're dropped: their payers enter a card again. Holds placed there
  /// stay theirs (`State.heldWith`), settled when it's connected again.
  async function adopt(account: string) {
    const kept = await state.load();
    // Holds kept before they were bound to an account (`State.heldWith`)
    // were placed with the account this agent was running then: the one it
    // last ran, if it kept that, or else this one. Once set, it stays.
    const legacy = kept.legacy ?? kept.account ?? account;
    if (kept.account === account && kept.legacy === legacy) return;
    if (kept.account !== null && kept.account !== account) Object.assign(kept, { saved: {}, savedAt: {}, challenged: {} });
    kept.legacy = legacy;
    kept.account = account;
    await state.save(kept);
  }

  /// What the network says of this payee follows the keys this device keeps
  /// -- published while it has some, withdrawn when it has none -- so a change
  /// a crash cut short is put right at the next start. Both calls do nothing
  /// when the network already says so.
  async function reconcile(kept: Credentials | null) {
    if (kept) await dispatch("set_payment_profile", profileOf(kept.processor, kept.connection));
    else await dispatch("clear_payment_profile", null);
  }

  return {
    /// Starts rounds with the keys already kept, if any.
    /// Puts the network's profile right by the keys kept here, then starts
    /// rounds with them -- or, if that can't be done yet, tries again each
    /// tick, paying nothing meanwhile.
    async start() {
      timer ??= setInterval(tick, roundMs);
      await begin().then(round, (err) => onProblem("round", err));
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
      // Keys refused now were mistyped, not revoked: said so.
      const connection = await processorFor(processor, keys, network.currency)
        .connect()
        .catch((err) => {
          throw err instanceof KeyRefused ? new Refused(`Those keys weren't accepted by ${processor}. Check them in its dashboard, then try again.`) : err;
        });
      if (connection.live !== network.live_payments) {
        if (network.live_payments) throw new Refused("This network takes real payments: use your account's live keys.");
        throw new Refused("This network is for testing: use your account's test keys.");
      }
      if (connection.currency.toUpperCase() !== network.currency.toUpperCase()) throw new Refused(`That account takes ${connection.currency.toUpperCase()}; this network pays in ${network.currency.toUpperCase()}.`);
      if (!(await confirm({ processor, connection }))) throw new Refused("Not connected: you didn't confirm it.");
      await inTurn(async () => {
        try {
          await dispatch("set_payment_profile", profileOf(processor, connection));
          await credentials.save({ processor, keys, connection });
          await use(processor, keys, connection, network.currency);
        } catch (err) {
          // Cut short: start over from the keys still kept here -- the
          // network's profile put back to match them, then rounds with
          // them -- as a start does, now and each tick until it can.
          engine = null;
          reconciled = false;
          throw err;
        }
        trouble = null;
        reconciled = true;
      }).catch((err) => {
        tick();
        throw err;
      });
      round();
      return { processor, account: connection.account, live: connection.live, trouble: null };
    },

    /// Withdraws the payment profile and forgets the keys. Payments already
    /// held settle once it's connected again.
    async disconnect() {
      if (!(await confirm(null))) throw new Refused("Still connected: you didn't confirm it.");
      // The keys go first: cut short after that, the next start withdraws
      // the profile too, rather than finding keys and carrying on with them.
      await inTurn(async () => {
        await credentials.clear();
        engine = null;
        trouble = null;
        reconciled = false;
        await dispatch("clear_payment_profile", null);
        reconciled = true;
      });
    },

    /// Looks for payments due now, not at the next round.
    wake() {
      tick();
    },

    /// A round, awaited: how many payments it carried out.
    async round(): Promise<number> {
      return rounded();
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
