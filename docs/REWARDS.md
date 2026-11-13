# Rewards

Each store can run its own rewards program: points for what customers spend, rewards they buy with them, status levels, boosts, birthdays and expiry. It's the store's program, not the platform's, and it runs without a server. A member's points are private between them and the store: nothing about them is published. Both sides work them out from what already happened, with the same rules.

## What a store can set

| Setting | Range |
|---|---|
| Name, what points are called, tagline, card colour (six) | |
| Points per dollar of food | 1 to 100 |
| Smallest order that earns, cap per order | Optional |
| Welcome bonus, on a member's first earning order | Up to 100,000 |
| Item boosts: an item earning faster | Up to 20 items, 1.01× to 10× |
| Happy hours: days and a time window earning faster | Up to 7, 1.01× to 5×, in the store's time zone (daylight saving included) |
| Rewards: a free item, a percent off an item, an amount off, a percent off the order | Up to 24, each with a cost and the level it needs |
| Status levels, by points earned in a calendar year, kept through the next year | Up to 4, each earning 1× to 3× and at least as fast as the one below |
| Birthday points, once a year in a member's birthday month | Up to 100,000 |
| Expiry, after so many days without an order | Off, or 30 to 1,095 days |
| Most a member can hold | Off, or at least the dearest reward's cost |

The program is versioned: changing it writes a new version. Each order cites the version it was placed under, which fixes what it earns and what its reward costs. The store's app refuses an order that cites a replaced version (unless it just raced the change), the same way it refuses an order priced from an old menu.

## How points move

No points ledger is published, so there is no balance to forge, and nothing to read. A member's points at a store follow from what the store itself holds:

- the orders it accepted from them that joined its program, each linked publicly from the member as it accepts it (`MemberToOrder`), like the orders themselves;
- its settlement of each, once the refund period is over;
- the rewards those orders spent;
- its own grants to them.

The store's app plays those through the pure rules in `rewards_types::points` (`replay`) before it accepts an order that spends a reward. The member's app works out the same from their own orders and the grants sealed to them, to show their card, what's on its way and what they've redeemed. The two agree because they read the same records with the same function, and events at the same moment always play in the same order.

- **Earn.** An order earns once the store has settled it and the refund period is over.
  - **The refund period** is the network's window to appeal the settlement (`appeal_window_secs`, 14 days by default), on a network with arbiters. Until then the points show as pending: on the card, in an "On the way" list, and on the order's page. The store doesn't count them yet either.
  - **An appealed order** waits for the arbiter's ruling, and earns on what the customer kept paying: the award is taken off.
  - Points come from the food paid, after discounts, the refund and any award, without tax, split across the lines. Bonus items earn faster, then a happy hour (judged by when the *store* accepted the order), then the member's tier, then the per-order cap, then the welcome bonus on their first order.
- **Redeem.** In the app, a member opens a store's rewards and taps one: it goes in their bag, free, and its points are held, shown as spent, until the order goes in. Taking it out frees them.
  - The order names the reward (`OrderRewards::reward`). Validation checks the order's total takes exactly that reward off, priced like a promo with no requirement, at a running program version. A reward replaces any promo code, and doesn't apply to goodie bags.
  - **The store decides whether the points cover it**, from its own records, as it accepts the order (`can_redeem`). An order whose points don't cover it, or whose tier doesn't reach it, is declined (`RewardUnavailable`), and nothing is charged.
  - An order the store never accepted spends nothing: cancelled first, or declined. One whose food the store gave back returns its points too.
- **Gift.** A store's grant (`PointsGrant`) is sealed between the store and the member: what it gives is private; whom it's to, from which store, and an order they placed there are public. A store can only give points to its own customers, so nobody can fill a stranger's inbox. The member's app reads a store's grants by its owner's key, so nobody else's can crowd them out, and knows each is the store's, because only the store's key could have sealed it. Stores use grants for goodwill and birthdays -- including with an answer to a customer's report of missing or wrong items, where the store can add points as an apology on top of any refund. That grant is a call of its own after the answer, so one that fails never undoes the answer; the store is told, and can give them again.

## Accounts: a running total, not a whole history

Playing a member's whole history every time costs every order they ever placed, several network reads each. That's about 35 ms per order for a card and 22 ms for the store's check, measured on a laptop, so a regular with a few hundred orders would wait seconds. So each side keeps its reckoning as a private running total (`rewards_types::ledger`, `MemberAccount`), on its own device: the store one per member, the member one per store. Nothing about it is published.

- **What's folded can't change.** An order is folded into the total once nothing about it can: its store settled it and its refund period is over (an appeal ruled), or it ended without the store accepting it. Until then it stays open, and every read plays it on top.
- **Everything folded came before everything open** (`through`): nothing at or after the oldest open order's placing is folded, nor anything after an event of a done order that can't be folded whole. So the rules always play one history, in order, and a folded total plus the open orders is exactly what playing everything would give. The unit tests hold it to that against a full replay, read every simulated day, for 501, 5,000 and 50,000 orders (`cargo test --release -p rewards_types -- --ignored` for the last). The program they use has tiers rolling by year, expiry, a welcome and caps.
- **Played afresh when it must be:** the first time an account is read (accounts from before they were kept, too); when the store changes its program, since every point plays under its current rules; and when a grant turns up dated before what's folded. Afresh means from every record, however many. Nothing is ever cut off at a count.
- **Kept where the records change.** The store carries a member's account forward as it accepts their order or gives them points, in the same call. The member's is noted as they place an order. A card read that folds something keeps it in a call of its own, only if no newer version was written meanwhile, so a race costs a repeat, never a lost order. Recording an accepted order twice records it once: its link is found by its exact tag.
- **Behind an open order.** An order still open holds back folding everything after it: a refund or a cancellation could still change what came later. Those later orders stay in the account with what's been learned of each (accepted, settled), kept whenever a read learns something new. A settled order is checked once a read for an appeal, until its window has closed, plus the time an appeal filed at the last moment may take to arrive (`appeal_arrival_secs`, a day by default). From then on it costs nothing to read.
- **Only a cache.** What an account folds is public: the store's links to its acceptances (`MemberToOrder`), its settlements, its grants (opened with its own key), and the member's own orders. A device restored from the network has none of the private totals, and plays them all again from those, gifts included.
- **Found without walking the chain.** Each version is written whole, followed by a marker whose content is only *which account, which version*. Its hash is the same every time, so the latest version is found by looking a few markers up (doubling, then halving between), however many versions there are. The version is the action just before its marker. Private entries can't be updated on this network (an update needs the network to see what it updates), which is why versions are new entries.

A read then costs what's still open (at most a few weeks of orders, the refund period), plus a handful of lookups, at any account's age.

## When a store moves

- **To a restored device, same key:** nothing is lost. Its accounts play again from the public records, its member list (`StoreToMember`) and its links to their orders come back with the network, and the birth months it had read are read again, in turn.
- **To its owner's new key, after a recovery** (`catalog::move_store`): the program is copied to the new store, naming the copies of its items and choice groups. Members' points carry on by themselves: the new store plays each member's history across its whole line of stores (the old store, as `catalog::store_line` says, and any before it), so earning, spending, tier and all go on. Gifts the old key gave are sealed to it, and it's gone, so the member shows them to the new key (`reveal_my_gifts`). Their app does this the first time it plays the store's card, and again as they order there, in case the first try didn't get through. Each is then counted, by the store and by the card alike, once it matches the grant's public commitment (below).
- **To a new network** (`catalog::import_store`, docs/MIGRATION.md): the program is copied, read from the previous network. As a member's account leaves the old network, it seals every grant it was given to its new key there (`carry_my_gifts`, called by `migrate_out`). On their first order at the store that came over, their app shows the store those grants. The store's owner, with their new key, then asks the old network what the member held (`carried_balance`), played from its public records and the gifts shown, each proven. The old network answers only the store's owner, or the key its owner's migration names. The store grants the member that, as points carried over (`GrantReason::Carried`) citing the order, and tops it up if they show more later. If the old network can't be reached, it tries again on their next order. Tier and history start again on the new network; the balance doesn't.

**Proving a gift to someone it wasn't sealed to.** A grant's payload carries random salt, and the grant publishes a hash of who it's to, from which store, and the payload (`grant_commitment`). The hash gives nothing away, since the salt means the amount can't be guessed by trying them. Shown the payload (`RevealedGrant`), anyone can check it matches what the store said. Only the member, or the store, could have opened it to show it.

**Sizes:** a member's gifts are shown, or carried, in as many entries as they take, each up to half of Holochain's entry limit (`MAX_GIFT_LIST_BYTES`). However many gifts there are, none is left out.

Tested on real conductors:
- `tests/tryorama/src/rewards-continuity.test.ts` restores a store's device, then moves the store to its owner's new key, gifts included.
- `tests/tryorama/src/rewards-migration.test.ts` carries a member's earned and given points across two real networks, and checks that only the store's owner, or the key they moved to, can ask.

Both check the member's card and the store's count against each other, to the point.

## Time can't be faked

People choose their own entries' timestamps, so no rule depends on one where faking it would pay:

- **Earning** is dated by the store's settlement. That decides expiry and which year counts toward their tier.
- **Happy hours** are judged by when the store accepted the order, on the store's own clock.
- **Spending** is dated by the store's acceptance, and checked then.
- **Gifts** don't count as activity, so a grant can't keep points from expiring.
- **Birthdays.** A member sets their birth month once, on their device only (`BirthMonth`, a private entry). Their app tells each store they order from, sealed so only that store can read it (`BirthdayShare`). The store looks up only its own members, by their keys, and keeps each month privately once read (`MemberBirthday`). It takes the first month a member tells it, and celebrates once a year, only members who've bought there (a settled order) and first ordered at least 30 days before.

## Abuse considered

| Attempt | What stops it |
|---|---|
| Stating a balance, or spending more than they have | There's no balance to state. The store works out their points from its own records before accepting a reward, and declines it if they don't cover it |
| A reward above their level | The same: the store's replay knows their tier |
| A discount without a reward, or a bigger one than the reward | Validation recomputes the order's total, with the named reward or none |
| Citing an old, more generous program version | The store's app refuses to accept the order |
| A gift "from" a store, sealed by someone else | The member's app opens a grant with its sealer's key and counts it only if that's the store's owner. The store counts only its own |
| Fake accounts farming welcome bonuses | A welcome comes only with a settled order that earns on its own: the account has paid the store by card for real food |
| Fake accounts farming birthdays | 30 days of membership, once a year |
| A store and a customer colluding | They can only give away the store's own food |
| Earning on an order, then getting it refunded | Points are earned only after the refund period, on what was finally paid |
| Learning someone's points or birthday | Neither is published. A grant's and a birthday's contents are sealed; a store's running totals and the birth months it has read are private to its device. Its links to members' orders reveal no more than the orders themselves |
| A stranger's store filling someone's wallet or inbox with gifts | A grant must cite an order its recipient placed at that store, by its owner (validation), so only a store's own customers can be sent one. A store's grants are read by its owner's key, so nobody else's can hide them |
| Flooding a store with birthday shares | A share must cite an order its author placed there; the store reads only its own buying members', by key |
| Two acceptances recording the same order, or a card read racing an order being placed | The record is found by its own hash, so a repeat records nothing; a read keeps its fold only if no version was written meanwhile |
| Spending a reward on an order, then cancelling it on a stale branch | The reward comes back only if the order was called off before the customer saw the store start -- the same rule as the food |
| Spending the same points twice, on two orders the store answers at once (two devices, or a modified app) | The store's chain is written in strict order: of two acceptances at once, the second to commit finds the chain moved and fails, and tried again it counts the first's spend. The points check is the store's app's, never re-run at commit, so accepting must never write with relaxed ordering |

## What's left

- **Orders are public.** Anyone can see who ordered from whom, and so could estimate someone's points at a store from their orders. The balance itself, the gifts, the rewards and the birth month aren't published.
- **A store could refuse a reward its member can afford.** It's the store's own program, and the refusal is recorded on the order, so the customer knows.
- **A store's program stats and birthday sweep still read its whole chain**: the stats on its dashboard, and the birthday sweep a few times a day (one walk for all members, not one each). Neither decides anyone's points. Both are worth an index of members if stores grow very large.
- **An order open a long time holds its member's account back**: an appeal waiting months keeps everything after it unfolded, so reads of that member cost more until it's ruled. It never makes them wrong.

## Where it lives

- `dnas/handshake/zomes/rewards/types`: the program, grants and private records; `points.rs`, the rules and `replay` (unit-tested); `ledger.rs`, the running total and when an order can be folded into it (tested against a full replay); `earn.rs`, what an order earns.
- `dnas/handshake/zomes/rewards/integrity`: validation of programs, sealed grants and birthdays.
- `dnas/handshake/zomes/rewards/coordinator`: programs, cards (the member's view), `can_redeem` and `record_member_order` (the store's), each side's accounts (`accounts.rs`), grants, birthdays, stats.
- `dnas/handshake/zomes/dispatch/coordinator/src/acceptance.rs`: what the store checks before accepting: points, a newcomer's verified card, serial cancellers.
- `dnas/handshake/zomes/dispatch/integrity/src/checks.rs`: an order's rewards and reward pricing (`check_rewards`).
- `dnas/handshake/zomes/dispatch/coordinator/src/pricing.rs`: joining a program at checkout, and the store's current-version check (`ensure_current_program`); `settlement.rs`, the store's settlement that earning rests on.
- `web/src/lib/rewards/rewards.ts`: the same rules, for previews (`web/test/rewards.test.ts` runs the Rust cases).
- `web/src/routes/customer/Rewards.tsx`: the wallet, each card, the store page's strip. `web/src/routes/customer/RedeemRewards.tsx`: the redeem screen. The bag holds the reward (`web/src/store/cart.ts`). `web/src/routes/merchant/Rewards.tsx`: the program builder. `web/src/components/rewards/`: the card, the tiles, the levels.
- Tests: `tests/tryorama/src/rewards.test.ts` (on real conductors), `rewards-concurrency.test.ts` (two acceptances at once, cancels on a stale branch), `rewards-refund-period.test.ts`, `newcomer-protections.test.ts`, `web/e2e/rewards.spec.ts`.
