// How HandShake's calls slow down as a store, an account and a moment get
// busy -- on real conductors, measured, not guessed. Not part of the suite
// (it takes a while and its numbers depend on the machine):
//
//   npx tsx bench/scale.ts                       every section, default sizes
//   npx tsx bench/scale.ts --menu 25,100,250     a menu this big, item by item
//   npx tsx bench/scale.ts --orders 10,50,150    one customer this many orders in
//   npx tsx bench/scale.ts --pinned 10,50        one order left open, the rest settled
//   npx tsx bench/scale.ts --at-once 25,100,250  this many more orders open at once
//   npx tsx bench/scale.ts --crowd 10            customers the open orders come from
//   npx tsx bench/scale.ts --json out.json       the numbers, for comparing runs
//   npx tsx bench/scale.ts --only orders         one section
//   npx tsx bench/scale.ts --repeats 20          more calls per read, for p95
//
// Three conductors: the store's, its customers' (one long-lived customer
// and the crowd, each a separate agent), and a driver's. Every read is
// timed from the side that makes it for real, after the network has caught
// up, so what's measured is the call, not gossip: its first call (cold),
// then the median, 95th percentile and slowest of the rest (warm).
//
// - **A big menu.** The store's items, read whole as a customer's app does
//   (page by page), and an order placed against it.
// - **A long-lived customer at a busy store.** The same customer's Nth
//   order, each settled as the store's app would: placing it (validation
//   walks their history for promo limits and the cancel allowance), the
//   store accepting it (it plays their points), their card and history,
//   the store's queues.
//   At each size, the store changes its program, and both sides play the
//   whole history afresh: what a first read of a long account costs.
// - **An order left open.** Another customer whose first order is never
//   settled, the rest settled: everything after it stays open, the worst a
//   long-unresolved order can do to an account.
// - **Many orders at once.** A crowd of customers ordering from one store
//   together, until hundreds are open: how long until every one is placed
//   and accepted, how many acceptances the store's chain moving under them
//   turned away first, and what a driver's feed costs -- checked to list
//   no more than the network's limit, oldest first.
import { writeFileSync } from "node:fs";
import { dhtSync, runScenario, type PlayerApp } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, customerPaid, decodeEntry, installManyAgents, retryUntil, retryUntilOk, retryingCaller, shareAgentsOn, ST_PETE, useTestCoordinators } from "../src/helpers.js";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(`--${name}`) + 1];
const sizes = (name: string, fallback: number[]) => (args.includes(`--${name}`) ? option(name).split(",").map(Number) : fallback);
const MENU = sizes("menu", [25, 100, 250]);
const ORDERS = sizes("orders", [10, 50, 150]);
const PINNED = sizes("pinned", [10, 50]);
const AT_ONCE = sizes("at-once", [25, 100, 250]);
const CROWD = args.includes("--crowd") ? Math.max(1, Number(option("crowd"))) : 10;
/// The feed's limit (`max_listed_orders`), as this network leaves it.
const FEED_LIMIT = 100;
const ONLY = args.includes("--only") ? option("only") : null;
const JSON_OUT = args.includes("--json") ? option("json") : null;
const REPEATS = args.includes("--repeats") ? Math.max(2, Number(option("repeats"))) : 5;
/// The network's limits, opened up: one customer here places hundreds of
/// orders, and cancels many, in minutes -- what a whole neighbourhood would.
const PROPERTIES = { max_pending_orders: 1_000, max_daily_early_cancels: 1_000 };

/// Every measurement, by section: what was measured, at what size, in ms
/// -- the median, and for reads the cold call and the warm spread.
const results: { section: string; size: number; what: string; ms: number; cold?: number; p95?: number; max?: number }[] = [];
function note(section: string, size: number, what: string, ms: number, spread?: Spread) {
  const round = (n?: number) => (n === undefined ? undefined : Math.round(n));
  results.push({ section, size, what, ms: Math.round(ms), cold: round(spread?.cold), p95: round(spread?.p95), max: round(spread?.max) });
}

interface Spread {
  cold: number;
  p50: number;
  p95: number;
  max: number;
}

/// `fn` timed `times` times, in ms: the first call, then the rest's spread.
async function spread(fn: () => Promise<unknown>, times = REPEATS): Promise<Spread> {
  const taken: number[] = [];
  for (let i = 0; i < times; i++) {
    const started = performance.now();
    await fn();
    taken.push(performance.now() - started);
  }
  const [cold, ...warm] = taken;
  warm.sort((a, b) => a - b);
  const at = (q: number) => warm[Math.min(warm.length - 1, Math.floor(q * warm.length))];
  return { cold, p50: at(0.5), p95: at(0.95), max: warm[warm.length - 1] };
}

/// `fn`'s median time over `times` warm calls, in ms.
async function median(fn: () => Promise<unknown>, times = REPEATS): Promise<number> {
  return (await spread(fn, times)).p50;
}

/// How long `fn` takes, once, in ms -- and what it gave.
async function once<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
}

const want = (section: string) => ONLY === null || ONLY === section;

await runScenario(async (scenario) => {
  const conductors = [await scenario.addConductor(), await scenario.addConductor(), await scenario.addConductor()];
  // The menu's reader orders and cancels to time it, which a store counts
  // against them: someone other than the long-lived customer.
  const [[merchant], [customer, browser, pinner, ...crowd], [driver]] = [
    await installManyAgents(conductors[0], 1, "store", PROPERTIES),
    await installManyAgents(conductors[1], 3 + CROWD, "customer", PROPERTIES),
    await installManyAgents(conductors[2], 1, "driver", PROPERTIES),
  ];
  const network = merchant.cells[0].cell_id[0];
  await shareAgentsOn(conductors, network);
  const everyone: PlayerApp[] = [merchant, customer, browser, pinner, ...crowd, driver];
  for (const p of everyone) await useTestCoordinators(p, ["dispatch"]);
  const call = (p: PlayerApp, zome: string) => retryingCaller(p.cells[0], zome);
  const sync = (players: PlayerApp[] = everyone) => dhtSync(players, network, 500, 10 * 60_000);

  const now = Date.now() * 1000;
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  for (const [i, p] of [customer, browser, pinner, ...crowd].entries()) await call(p, "profiles")("create_profile", { display_name: `Customer ${i}`, roles: ["Requester"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = async (n: number) => actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: `Dish ${n}`, price_cents: 500 + (n % 20) * 25, available: true }));
  const stew = await item(0);
  let items = 1;
  // A rewards program, so the store's acceptance replays its member's
  // points as it would for a real store running one.
  const programSettings = {
    catalog_ref: store, active: true, name: "Mo's Rewards", points_name: "points", tagline: "", accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 0, item_bonuses: [], happy_hours: [] },
    tiers: [], rewards: [{ id: 1, name: "$1 off", cost: 100, benefit: { FlatOffSubtotal: 100 }, min_tier: 0 }],
    birthday_points: 0, expiry_days: null, max_balance: null, time_zone: "UTC",
  };
  await call(merchant, "rewards")("save_program", programSettings);
  await sync();

  /// The whole menu, page by page, as a customer's app reads it.
  const wholeMenu = async (by: PlayerApp) => {
    let after: number | null = null;
    let count = 0;
    do {
      const page: { items: unknown[]; next_after: number | null } = await call(by, "catalog")("list_menu_items", { catalog_ref: store, after });
      count += page.items.length;
      after = page.next_after;
    } while (after !== null);
    return count;
  };
  const pickup = (by: PlayerApp) => retryUntilOk(() => call(by, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 500 }));
  /// `who` ordering, the store accepting, and `who` collecting it --
  /// settled after, as the store's app would, if `settle`. How long placing
  /// and accepting took.
  const fulfilled = async (who: PlayerApp, settle: boolean) => {
    const [record, placeMs] = await once(() => pickup(who));
    const order = actionHash(record);
    await sync([merchant, who]);
    await customerPaid(merchant, order, [merchant, who]);
    const [, acceptMs] = await once(() => retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order })));
    await call(merchant, "dispatch")("mark_ready_for_pickup", order);
    await sync([merchant, who]);
    await retryUntilOk(() => call(who, "dispatch")("complete_pickup", order), 40);
    if (settle) {
      await sync([merchant, who]);
      await retryUntil(() => call(merchant, "dispatch")("settle_order", order).then(() => call(who, "dispatch")<{ refund: number | null }>("get_order_decisions", order)), (d) => d.refund !== null, 60, 1000);
    }
    return [placeMs, acceptMs] as const;
  };
  /// A member's card, and the store's check of a reward for them.
  const card = (who: PlayerApp) => call(who, "rewards")<{ program: { version: Uint8Array } | null }>("my_card", store);
  const check = (who: PlayerApp, program: Uint8Array | undefined) => call(merchant, "rewards")("can_redeem", { customer: who.agentPubKey, catalog_ref: store, program, reward: 1 }).catch(() => null);
  let programChanges = 0;

  // ===== A big menu =====
  if (want("menu")) {
    console.log("\nA big menu");
    for (const size of MENU) {
      let lastAdd = 0;
      while (items < size) {
        const started = performance.now();
        await item(items++);
        lastAdd = performance.now() - started;
      }
      await sync([merchant, browser]);
      const readSpread = await spread(() => wholeMenu(browser));
      const read = readSpread.p50;
      const count = await wholeMenu(browser);
      const order = await median(async () => call(browser, "dispatch")("cancel_pickup_order", actionHash(await pickup(browser))), 3);
      note("menu", size, "adding an item", lastAdd);
      note("menu", size, `reading the whole menu (${count} items)`, read, readSpread);
      note("menu", size, "placing an order, and cancelling it", order);
      console.log(`  ${String(size).padStart(5)} items: add ${lastAdd.toFixed(0)} ms, read whole ${read.toFixed(0)} ms, order+cancel ${order.toFixed(0)} ms`);
    }
  }

  // ===== A long-lived customer at a busy store =====
  if (want("orders")) {
    console.log("\nA long-lived customer at a busy store");
    let placed = 0;
    let placing: number[] = [];
    let accepting: number[] = [];
    const lastFew = (xs: number[]) => [...xs].slice(-REPEATS).sort((a, b) => a - b)[Math.floor(Math.min(REPEATS, xs.length) / 2)] ?? 0;
    for (const size of ORDERS) {
      while (placed < size) {
        const [placeMs, acceptMs] = await fulfilled(customer, true);
        placing.push(placeMs);
        accepting.push(acceptMs);
        placed++;
      }
      await sync([merchant, customer]);
      const program = (await card(customer)).program?.version;
      const reads: [short: string, what: string, read: () => Promise<unknown>][] = [
        ["card", "their card at the store", () => card(customer)],
        ["history", "their order history, first page", () => call(customer, "dispatch")("get_my_order_history", { before: null, limit: 20 })],
        ["count", "their completed orders there, counted", () => call(customer, "dispatch")("count_my_completed_orders", store)],
        ["store queue", "the store's active orders", () => call(merchant, "dispatch")("get_active_orders_for_store", store)],
        ["store history", "the store's order history, first page", () => call(merchant, "dispatch")("get_order_history_for_store", { catalog_ref: store, before: null, limit: 20 })],
        ["reward check", "the store checking a reward", () => check(customer, program)],
      ];
      note("orders", size, "placing the next order", lastFew(placing));
      note("orders", size, "the store accepting it", lastFew(accepting));
      const line = [`place ${lastFew(placing).toFixed(0)}`, `accept ${lastFew(accepting).toFixed(0)}`];
      for (const [short, what, read] of reads) {
        const timed = await spread(read);
        note("orders", size, what, timed.p50, timed);
        line.push(`${short} ${timed.p50.toFixed(0)} (cold ${timed.cold.toFixed(0)}, p95 ${timed.p95.toFixed(0)})`);
      }
      // The store changes its program: each side plays the whole history
      // afresh on its next read, as on a first read of a long account.
      await call(merchant, "rewards")("save_program", { ...programSettings, tagline: `Version ${++programChanges}` });
      await sync([merchant, customer]);
      const [changed, rebuildCard] = await once(() => retryUntil(() => card(customer), (c) => c.program !== null && Buffer.compare(Buffer.from(c.program.version), Buffer.from(program ?? [])) !== 0, 30, 500));
      const [, rebuildCheck] = await once(() => check(customer, changed.program?.version));
      note("orders", size, "their card, played afresh (a program change)", rebuildCard);
      note("orders", size, "the store's check, played afresh", rebuildCheck);
      line.push(`afresh: card ${rebuildCard.toFixed(0)}, reward check ${rebuildCheck.toFixed(0)}`);
      console.log(`  ${String(size).padStart(5)} orders: ${line.join(", ")} (ms)`);
      placing = [];
      accepting = [];
    }
  }

  // ===== An order left open =====
  if (want("pinned")) {
    console.log("\nAn order left open, everything after it settled");
    let placed = 0;
    for (const size of PINNED) {
      while (placed < size) {
        // Their first order is never settled: it holds back everything after.
        await fulfilled(pinner, placed > 0);
        placed++;
      }
      await sync([merchant, pinner]);
      const program = (await card(pinner)).program?.version;
      const cardSpread = await spread(() => card(pinner));
      const checkSpread = await spread(() => check(pinner, program));
      note("pinned", size, "their card", cardSpread.p50, cardSpread);
      note("pinned", size, "the store checking a reward", checkSpread.p50, checkSpread);
      console.log(`  ${String(size).padStart(5)} orders: card ${cardSpread.p50.toFixed(0)} (cold ${cardSpread.cold.toFixed(0)}), reward check ${checkSpread.p50.toFixed(0)} (cold ${checkSpread.cold.toFixed(0)}) (ms)`);
    }
  }

  // ===== Many orders at once =====
  if (want("at-once")) {
    console.log("\nMany orders at once");
    /// Every order opened so far, with when the store opened it.
    const open: { order: Uint8Array; opened: HcRecord }[] = [];
    let geohash = "";
    for (const count of AT_ONCE) {
      // The crowd's customers each place their share together.
      const whose = Array.from({ length: count }, (_, i) => crowd[i % crowd.length]);
      const [orders, placeMs] = await once(() =>
        Promise.all(
          whose.map((who) =>
            retryUntilOk(() => call(who, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 500, dropoff: ST_PETE, max_delivery_fee: 1_000 }), 40),
          ),
        ),
      );
      const refs = orders.map(actionHash);
      geohash = decodeEntry<{ dropoff_geohash: string }>(orders[0]).dropoff_geohash;
      await sync();
      await Promise.all(refs.map((ref) => customerPaid(merchant, ref, everyone)));
      // The store's app answers each as it hears of it -- all at once, here.
      let turnedAway = 0;
      const [, acceptMs] = await once(async () => {
        let waiting = refs;
        while (waiting.length) {
          const answers = await Promise.allSettled(waiting.map((ref) => merchant.cells[0].callZome<HcRecord>({ zome_name: "dispatch", fn_name: "accept_delivery_order", payload: { order_original_action: ref, prep_minutes: 10 } })));
          answers.forEach((a, i) => a.status === "fulfilled" && open.push({ order: waiting[i], opened: a.value }));
          turnedAway += answers.filter((a) => a.status === "rejected").length;
          waiting = waiting.filter((_, i) => answers[i].status === "rejected");
        }
      });
      await sync();
      const listedNow = await retryUntil(() => call(driver, "dispatch")<HcRecord[]>("get_open_orders_near", geohash), (r) => r.length >= Math.min(open.length, FEED_LIMIT), 30, 1000);
      const feedSpread = await spread(() => call(driver, "dispatch")<HcRecord[]>("get_open_orders_near", geohash));
      const active = await median(() => call(merchant, "dispatch")("get_active_orders_for_store", store));
      // No more than the limit, and the oldest: nothing listed opened after
      // anything left out.
      const listed = new Set(listedNow.map((r) => Buffer.from(actionHash(r)).toString("hex")));
      const openedAt = (o: { opened: HcRecord }) => o.opened.signed_action.hashed.content.header.timestamp;
      const left = open.filter((o) => !listed.has(Buffer.from(actionHash(o.opened)).toString("hex")));
      const newestListed = Math.max(...open.filter((o) => listed.has(Buffer.from(actionHash(o.opened)).toString("hex"))).map(openedAt));
      const oldestFirst = left.every((o) => openedAt(o) >= newestListed);
      if (listedNow.length > FEED_LIMIT || !oldestFirst) throw new Error(`the feed listed ${listedNow.length} of ${open.length} open, oldest first: ${oldestFirst}`);
      note("at-once", count, "placing them all", placeMs);
      note("at-once", count, "the store accepting them all", acceptMs);
      note("at-once", count, "acceptances turned away first (count)", turnedAway);
      note("at-once", count, `a driver's feed (${listedNow.length} listed of ${open.length} open)`, feedSpread.p50, feedSpread);
      note("at-once", count, "the store's active orders", active);
      console.log(`  ${String(count).padStart(5)} more: place all ${placeMs.toFixed(0)} ms, accept all ${acceptMs.toFixed(0)} ms (${turnedAway} turned away first), driver feed ${feedSpread.p50.toFixed(0)} ms (cold ${feedSpread.cold.toFixed(0)}, p95 ${feedSpread.p95.toFixed(0)}) listing ${listedNow.length} of ${open.length} open, oldest first; store queue ${active.toFixed(0)} ms`);
    }
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    console.log(`\nWrote ${JSON_OUT}`);
  }
});
