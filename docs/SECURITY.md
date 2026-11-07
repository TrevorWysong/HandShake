# Security

HandShake has no server to enforce anything. Every rule that matters is in the DNA's validation, which every peer runs on everything it stores. This page covers who we defend against, what validation guarantees and how, and what it can't.

## Threat model

Assume every peer may run a modified app, and a modified conductor that skips validating its own writes. Code that runs only on the author's own conductor (any coordinator zome) protects only honest users. A rule protects the network only if it lives in integrity validation.

Identities are free: anyone can make a new key at any moment. Nothing may depend on an identity having something to lose, unless it has visibly put that thing at stake (a card authorization held against it).

Peers choose their own action timestamps. Holochain only requires each agent's timestamps to increase along their own chain. A timestamp is the author's claim, so no rule may let a later timestamp win over someone else's action.

## What validation guarantees, and how

**Every op of every action.** Holochain validates each action as several ops, each at a different authority: the record, the entry, an update registered at its original, a link at its base, and agent activity. Every integrity zome routes all of these through the same rules (`handshake_integrity_support::classify`). Otherwise a rule would hold at one authority and not at the others.

**Only an entry's author changes it.** Every update checks the author of the version it replaces, and keeps identity fields fixed: a store's owner, a menu item's store, a bid's bidder, a credential's driver. Entries that orders, payments or reviews refer to can't be deleted.

**Money moves directly, and only as the network says** (`dispatch_integrity::payments`, `dispatch_types::direct`; [DIRECT_PAYMENTS.md](DIRECT_PAYMENTS.md)).
- There are no balances, credits or issuers. Each payment is a card authorization its payee holds on their own processor account: the customer's card by the store, the store's card by the driver for their pay, and the driver's card by the store as collateral.
- A hold answers an offer its leg's payer wrote (their card token sealed to the payee), is recorded by that leg's payee only, once per leg, and is for exactly the amount the network works out from the order's terms and bid.
- Each step of an order cites the hold it needs: the store accepting cites the customer's; the driver committing cites their collateral and their pay.
- Each hold is settled once, by its payee. Every part captured is checked against the decision that entitles it (`direct::entitlement`), and a store passing on the customer's share of a fee or tip cites the driver's own settlement of it. A capture beyond the hold is refused.
- What a payee actually does on its processor is outside validation. Its signed settlement is public, so a payee who charges more than it says has a record against it, and its payer a clear dispute with their bank.
- Before pickup, a cancellation decides what each party is owed. After it, every payment cites one of the store's two decisions about the order: its outcome (delivered, or not) or its settlement of the food. The store can write each only once per order, so no two payments can rest on contradictory decisions (see "Who decides" below).

**Order history.** An entry's current version is the tip of its longest branch of updates, never the latest timestamp (`handshake_coordinator_support::resolve_latest`). Money doesn't depend on which branch wins, because each party settles from the exact versions it cites.

**Reputation is summed from evidence, never from summaries.**
- Each review's link carries its rating and order, and validation checks both against the review.
- A rating counts one vote per customer per order.
- No checkpoint someone else wrote is trusted, because nobody can verify it's complete.
- Only an order's own customer, store or driver records events about it, and every event cites what it rests on: the order version it records (a completion, a cancellation, a claim) or the store's decision. Validation checks the event against that record: a completion only from a completed version, a cancellation only against whoever cancelled.
- A driver's completed delivery and every outcome event (an order that never arrived, a claim that it hadn't, forfeited collateral) are recorded only by the store, citing its decision. Forfeited collateral must be exactly the bid's.

**Content.**
- Images must be inline PNG, JPEG, WebP or GIF, within the network's `max_image_bytes`. Never a link, which would tell a server who viewed what, and never an SVG, which can carry script.
- Every free-text field, list and sealed field has a size limit (`handshake_integrity_support::limits`, shared with the app's forms). A sealed photo is stored as chunks the conductor can seal, bounded in number and size.
- Every link indexes a record. Anchors are computed hashes, never trees of links, so nobody can clutter one with links to nothing. A history day is indexed only by an order's customer, for the day the order was placed.

**Orders cite the terms they were placed under.** Each delivery names the store version it was placed against (`catalog_version`). Validation checks the order's fee split is that version's, its public drop-off area (a geohash cell of fixed size) lies within that version's delivery radius, and its subtotal meets that version's minimum. Validation can't tell an old version from the current one, so the store's acceptance refuses an order whose cited terms give it more than the store's current terms (a lower minimum, a wider area, a larger fee share), unless it raced the change -- the same check, on the store's own chain, as for prices. Pickup orders cite their store version too.
- The production UI ships a Content-Security-Policy that allows only its own code, inline images, the local conductor and OpenStreetMap.

**Signals.** `recv_remote_signal` checks who actually sent a signal against the order it's about. Anything it tells the user is read from the order, not from the payload. A signal that doesn't check out is dropped.

**Store acceptance.** Validation can't tell an old price or a deactivated promo from a current one, because it sees records as they were. The store's own conductor checks both against its own chain before accepting, and only the store can accept.

**Handoffs** (`attestation::legs`, `dispatch::pin`, `dispatch_integrity::delivery`).
- Each delivery has two handoff codes: the customer's (committed when the order is placed) and the store's (committed when it accepts). The order publishes only `sha256(pin || salt)`; each code is sealed to its owner. Without the salt, nobody can test guesses against the commitment.
- The giver proves a handoff in one of three ways. The driver scans their code, which validation checks against the commitment. The giver confirms it in their own app (a `ReceiptAttestation`, signed on their chain). Or the driver types the digits read out, and the giver's own conductor checks them and confirms. That conductor counts wrong codes privately and stops answering after `max_code_attempts` (five by default).
- Validation refuses a pickup without the store's proof, and a delivery without the customer's. A completed delivery can't be claimed undelivered.
- Leaving an order at the door is the customer's choice, recorded on the order with their acceptance of the risk; validation refuses it otherwise. A drop-off left at the door completes the delivery. A store can set a limit (`leave_at_door_max_cents`) above which it won't accept such orders.
- A handoff's location and photo are sealed between its two parties.
- Drivers publish no presence: they find work by reading the open orders around them.

**How many orders a driver carries** (`dispatch_types::InHand`, `dispatch_integrity::carry`).
- Counted on the driver's own chain: each order they commit to is taken into their hands, and each `CarryEnded` they record (only for an order that has really ended for them) lets one go. Validation refuses a commitment past the network's `max_concurrent_deliveries`, a priority order alongside anything, and anything alongside a priority one. An order whose end its driver never records stops counting after two days, so the walk stays bounded; recording it sooner only frees them, so their app does.
- A delivery's total can't be zero, so every commitment posts collateral and is counted.
- A driver's queue of assigned orders is edited only by those orders' customers and stores, so a driver can't hide what they've taken on. Customers see it beside each bid, and their app won't accept a bid past the limit.

**Nobody crowds out anyone else.**
- A customer may place at most `max_pending_orders` orders within one store response window; validation counts them on their own chain. An order costs nothing until a store accepts it, so without this one identity could bury a store's queue.
- A driver bids on an order once; validation checks their own chain since the order opened. Otherwise one driver could fill an order's bids and push the others out of sight.
- A goodie bag is a line of an ordinary order, paid up front like the rest of it. Only the store's acceptance sells one: it counts the bags it has already sold (its own records, never behind) and declines an order for a sold-out bag, so no bag sells past its quantity, and nobody holds a store's bags without buying them. Validation holds each bag line to the bag's price, its store, its window, the ways it's offered, and never the store owner's own.
- A store's minimum order is checked against the store version the order cites, like its radius and fee split.
- One account opens at most `MAX_STORES_PER_OWNER` stores, counted on its own chain, and a store takes orders only once a processor account is connected and holding its customers' cards. A listing tag can't be carried by any other link, and a store is listed once.
- A customer orders each goodie bag once (unless the store declined that order before taking it on), reviews an order's store and driver once each, rates an item once per order, and reports each item on an order once, once they have it -- each checked on their own chain.
- Every amount is at most `limits::MAX_AMOUNT` and every quantity at most `limits::MAX_LINE_QUANTITY`, so no total can overflow; the release build also fails on overflow rather than wrapping.

**From commitment to pickup** (`dispatch::deliveries`, `dispatch_integrity::delivery`, `dispatch_types::lineage`).
- The driver commits (collateral held, the carry limit checked) before the store cooks; the store checks them in at its counter on its own conductor, against its code (wrong codes count toward `max_code_attempts`); only the store's own receipt of the driver's pickup leg is pickup proof. A store code a driver scans proves presence, never a handoff.
- Who may move a driver on: the driver themselves (their drop carries a time-source round), or the store once they've missed the offer window or are past due and not checked in. Nobody else. A driver who leaves an order the store started cooking answers for the food until the store confirms another driver; if none comes within `replacement_window_secs`, the store ends it (`NoDriver`): the customer is refunded and that driver's collateral pays the store. A driver the store checked in never answers for it.
- A checked-in driver kept waiting past the ready time by the store's own wait (`store_wait_minutes` on the version of its terms the order cites, within the network's bounds) calls the store late: they leave the order, proving the time with a round of the network's time source (drand, verified against its key in validation), paid their full bid from the store's card and with their collateral released (`lineage::is_store_late_release`, which the payment rules, the order rules and reputation all share). The order reopens to bids, and its customer may cancel for a full refund (`StoreLate`); a driver the store has checked in by then is paid by the store too.
- A customer collecting it themselves asks (`CollectRequest`, their consent, which the store's update must cite); the store's settlement must then refund at least its share of the fee it would have paid a driver.

**Deadlines that cost someone else are proved** (`handshake_integrity_support::beacon`). A record's own timestamp is its author's word, and Holochain lets authors date records ahead. So every deadline whose early claim costs someone else carries a fresh round of the network's time source, verified in validation: a driver leaving (it dates the window another driver has), calling a store late, the store moving on a committed driver (who then answers for the food), ending an order for no driver, and recording a customer who never came. The store's conductor can't reach the time source, so its app takes those steps (`get_store_steps_due`); its conductor takes the rest, which are its own word: moving on a driver who never committed, starting to cook. A driver's app refuses a check-in the store dated well off its own clock, so they know to report it.

**The payee's agent and its keys** (`payments/`). Processor keys live only on the payee's own device, sealed by its keystore, never on the network or in the app's pages. The app reaches the agent by four commands that take no amount and name no payment, so script in the app can't move money; the agent does only what `payments_due` says, with idempotency keys from the network records it answers, so a retry never charges twice. A Stripe key must be a restricted one. Card details go only into the payee's processor's own form (PCI SAQ A), and the app's content security policy admits only those processors' domains.

**Records decode only as their own type.** Validation often reads a record someone names (an order's collect request, a hold's order version) and decodes it as the type it expects. Every entry type refuses fields it doesn't have (`#[serde(deny_unknown_fields)]`), so a record of another type whose fields include the expected ones can't pass for it. Without that, a customer's shared address (which names its order) read as their asking to collect the order, and cost them their refund when a store ran late; an attacker could have used the same confusion on purpose.

**Sale prices.** A line claims a sale (`OrderLine::on_sale`) and its total is worked out at the sale's price. Validation refuses a claim on an item with no sale, or outside its fixed dates give or take the clock tolerance, and any other total. It has no time zones, so a weekly schedule is checked by the store's own conductor before it accepts (`pricing::lapsed_sale`), against when the order was placed, with the same grace a price change gets. A customer's clock is theirs, but a store can only accept within its response window, which bounds how far an order can be backdated into a sale. A scheduled order keeps the sale it was placed under. It's the store's own money either way, and it can decline.

**Menu choices.** An order line's choices are checked against the exact choice-group versions it names: every group the item offers is answered, within its limits, from options on offer at that version, from the item's own store, nested at most `MAX_CHOICE_DEPTH` deep. The line's price is recomputed from them, the cheapest free choices free, so a forged total is refused. Validation reads each group version once per order, and an order holds at most `MAX_ORDER_CHOICES` choices, so a hostile store and customer can't make an order expensive to check. As with item prices, validation can't tell a group's old version from its latest; the store's conductor refuses an order priced from choices it has since changed, past the price-change grace.

**Bounded histories and reports.** An order takes on at most `max_driver_changes` committed drivers and `max_offers_per_order` offers in all, so the history validation walks stays small and throwaway drivers letting offers lapse can't exhaust it; lapsed offers are on a driver's record and weigh against them in matching. A driver learns a customer's exact address only once they've committed, collateral posted, so winning a bid to harvest addresses costs something. A store's check-in-refused count includes only reports from drivers who've delivered for `min_reporter_stores` different stores, so a ring of throwaway identities can't bury a competitor. A driver's collateral never waits on the store's goodwill where a store could gain by withholding it: it comes back on their leaving from the counter, on another driver's confirmation or the customer collecting it, and on the store calling the order off. While a driver who left an order cooking answers for it, its customer can't cancel -- the store would be paid twice. Collateral is a real card authorization, so it can't be posted on credit and walked away from.

**Branches can't pay twice** (`dispatch_types::lineage`, `dispatch_integrity::basis`). An order's history can branch when two parties update the same version. Every rule that would pay on one branch what another branch pays is decided on a single chain: a driver can't both leave an order and pick it up; a store can't both move a driver on and check them in, end an order for no driver and confirm another, or hand over and release; a customer's refund that rests on someone else's update is refused if they cancelled the order (owing its driver) or asked to collect it (owing its food) on any branch. *Delivered* pays only the bid that delivered.

**Who decides** (`dispatch_types::issues`, `dispatch::issues`, `dispatch::never_arrived`).
- There is no referee. Proof settles almost every order. Where it can't, the store decides, because it has nothing to gain either way: it's paid for the food by the customer if the order arrived, or by the driver's collateral if it didn't.
- A customer can claim an order never arrived once it's picked up and until it's delivered. Validation refuses a claim from a customer who cancelled the order on another branch of its history: they'd be owed the driver's fee back after already conceding it.
- The store's outcome (`OrderOutcome`) is *delivered*, citing the order completed on proof, or *not delivered*, citing the customer's claim. Validation allows one per order (a walk of the store's chain back to the order's placement), only by its store, and never *not delivered* from a store that cancelled the order.
- On *not delivered*, nothing is charged to the customer, and the store captures the driver's collateral. On *delivered*, the driver captures their pay and their collateral is released. Each capture is checked against the decision it cites.
- Until the store decides, a driver who turns up late can still complete the delivery with proof. The store's app decides an unanswered claim after `claim_grace_secs` (30 minutes by default), or the store decides sooner.

**Missing and wrong items.**
- Only the order's customer reports, only items on the order, and never more units than were ordered. Only the store answers each report, and only once. Evidence is sealed to the store.
- The store's settlement (`ItemSettlement`) names the refund. Validation allows one per order, only by its store, citing that the customer has the order: its delivered outcome, or their own update collecting a pickup. The refund can't exceed what the cited reports are worth of what the customer paid: each unit at its price, scaled by any promo, never more than ordered (`claimed_value`).
- The store's app settles once the customer's report window (`report_window_secs`, 2 hours by default) has run. It refunds what the store accepted or never answered, and gives any late report up to `answer_grace_secs` (30 minutes by default) for an answer. The store has the final say, as it would if you ordered from it directly.

## 2026-10 audit: findings and fixes

Rows about the ledger, issuers, card attestation and the listing stake describe the credits design retired in November 2026 (direct payments replaced it); they're kept as the record of what was found.

| Finding | Severity | Fix |
| --- | --- | --- |
| Anyone could overwrite any store's details or menu items, through the app's own `update_menu_item` | Critical | Updates check the original's author and keep the owner and store fixed |
| Balance, rating and reputation checkpoints were self-asserted. One review let its author set a store's rating to anything; anyone could set their own balance | Critical | Checkpoints removed: balances are chain arithmetic, ratings are sums of validated link tags |
| Validation ran only at the entry's authority, so other authorities accepted anything a modified conductor published | Critical | Every op type goes through the same rules |
| Payment was optional and came after the food. Free identities meant free food, and the driver's collateral went to the customer, so a customer and driver working together could rob a store | Critical | Escrow, as above. Collateral goes to the store if the order never arrived |
| "Latest version" meant latest timestamp, which the writer chooses | High | Longest branch wins; money is independent of branches |
| Anyone could withdraw another driver's bid, or update another driver's beacon | High | Original-author checks |
| A payer could leave a debit out of their own balance | High | Balances are walked from the chain, not summed from links |
| Arbitrators could write payments and forfeits of any size, any number of times | High | Arbitrators removed: only an order's payers and payees write its money entries, each on one decision |
| Spoofed chat, location and order-status signals | Medium | Sender checked; notifications read from the order |
| Anyone could attach vehicle details to any driver, and drivers could mark themselves verified | Medium | Only the driver, and `verified` is reserved |
| Images could be remote URLs (tracking pixels) or unbounded blobs; no CSP | Medium | Inline raster only, size cap, CSP |
| Deactivated promo codes stayed redeemable | Medium | The store's acceptance checks the promo on its own chain |
| Strangers could record reputation events about any order | Medium | Only an order's parties; outcome events only its store, citing its decision |
| Reputation events weren't checked against the orders they described: a party could record a completion that never happened, or forfeited collateral of any amount | Medium | Every event cites its order version or the store's decision, and is checked against it |
| A delivery's radius was checked only by the customer's app, so a modified client could order from any distance, and choose its own fee split | Medium | Orders cite their store version; validation checks the radius and split against it |
| Loyalty counted only completions the customer wrote, so deliveries (completed by the driver) never counted | Low | A loyalty proof is any completed version of the customer's own order |
| Anchors accepted links to path nodes from anyone, so a peer could fill a store or history anchor with links to nothing | Low | Every link targets a record; history days are indexed by the order's customer |
| Lists and sealed fields had no size limit | Low | Limits on order lines, template items, and every sealed field |
| A photo sealed in one box exceeded what the conductor can seal, so real handoff and issue photos failed | High (availability) | Photos are sealed in chunks (`SealedChunks`) |
| A driver could bid any number of times on one order, pushing other drivers' bids out of sight | Medium | One bid per driver per order, checked on their chain |
| One identity could place any number of orders, free until accepted, burying a store's queue | Medium | `max_pending_orders` per store response window, checked on the customer's chain |
| A confirmed goodie-bag claim held its bag forever, even if never ordered | Medium | Claims are gone: a bag is sold only by the store accepting a paid order for it |
| Anyone could call a giver's typed-code check, spending their tries and locking them out | Medium | The check answers only the handoff's own driver |
| A customer could claim a goodie bag repeatedly, flooding a store's claims | Medium | One of each bag per customer, checked on their chain; orders are rate-limited |
| Unlimited reviews per order, and unlimited item reports (even before delivery), could bury a store's reviews or queue | Medium | Once per order and subject; each item reported once, only once the customer has the order |
| Anyone could publish unlimited stores, slowing every customer's browse | Medium | A refundable listing stake backs every listing |
| Amounts and quantities were unbounded, and release builds wrapped on overflow | Low | Protocol bounds, and overflow checks |
| A cancellation recorded by two parties counted twice | Low | Events count once per order and kind |
| Anyone could make a store's screen announce a new order, or a customer's announce a confirmed claim | Low | Shown only once verified; the wake-ups they trigger are idempotent |
| An order could cite an older version of its store's terms (a lower minimum, a wider radius, a larger fee share) | Medium | The store's acceptance refuses terms more generous than its current ones |
| The store's screen looked for missing-item reports only on orders placed in the last day | Low | It looks from completion, for the network's report window and answer grace |
| A driver who never showed was paid their fee if the customer cancelled, and an order no driver took could only be cancelled at the food's cost | Medium | Cooking starts on commitment; late drivers are moved on; a driver who leaves food cooked answers for it; a slow store pays the driver's fee; customers are refunded in each |
| A release, a cancellation and a delivery on different branches of an order's history could each pay out the same hold | High | Every conflicting rule is decided on one author's chain (`lineage`); customer refunds check the customer's own chain |
| The limit on concurrent deliveries was only the driver's own app, and a driver could delete their own queue links to hide their load | Medium | The ledger counts orders in hand and validation enforces the limit; only customers and stores retire a driver's queue |

The tests in `tests/tryorama/src/security-regressions.test.ts` and `ledger-rules.test.ts` replay these attacks.

## 2026-10-31 review: findings and fixes

| Finding | Severity | Fix |
| --- | --- | --- |
| A customer could cancel on the version of an order from before the store accepted it, as if the store never had, and get the food back after it was cooked (and keep a driver they'd taken from their fee) | Medium | A store whose own chain shows it started cooking, and never called the order off itself, is paid for the food whichever version was cancelled (`ledger_integrity::store_cooked`); a driver the customer had taken keeps their fee unless the driver left. A customer who cancelled writes nothing more on the order: no taking a driver, collecting it, or cancelling again elsewhere |
| Points could be earned on an order later refunded, through an appeal | Low | Points are earned only after the refund period (the appeal window), on what was finally paid less any award; pending until then (docs/REWARDS.md) |
| A scheduled order could be dated back, with its redemption, to dodge an expiry or land in a happy hour | Low | Happy hours are dated by the store's acceptance; rewards aren't spent on scheduled orders |
| Anyone running a store could fill a customer's chain and Rewards wallet with gifts, collected automatically | Low | Only gifts from stores the customer has ordered from, or points back for their own order, are collected automatically; the rest wait to be accepted |
| A member linking their birth month to a store over and over cost its app a year of grants re-read per link | Low | Each member once a sweep, and the store's grants read once |
| Behind a proxy that appends to `X-Forwarded-For`, the issuer and push relay rate-limited the address the client wrote | Low | They take the last entry, the one the trusted proxy added |
| A promo code had no limits: a "welcome" code worked forever, for anyone, and a loyalty code's proof could be reused on every later order | Medium | Stores set limits (`PromoLimits`). Validation holds "new customers only", uses per customer and once a day/week/month (the store's time) against the customer's own chain, so an order written past the app is refused too. A total across customers is enforced by the store's app as it accepts orders, counted from its own `PromoToOrder` links, and customers see what's left. Once-a-period codes aren't spent on scheduled orders, whose own date bounds nothing |
| A misspelled network setting (`arbitrators` for `arbiters`) was silently ignored, leaving appeals off | Medium | Packaging refuses any setting the network doesn't read, suggesting the name it meant |

## 2026-10-31 second review: findings and fixes

| Finding | Severity | Fix |
| --- | --- | --- |
| A store could accept on the version of an order from before its customer cancelled, and be paid for food the customer had called off in time | Medium | What decides it is the customer's own chain. Their app writes an `OrderConfirmation` by itself the moment it sees the store start. Cancelling before that costs nothing, however the store's branch reads; after it, the food is the store's (`ledger_integrity::confirmed_cooking`). A customer who cancelled can't confirm afterwards |
| A cancelled or declined order used up its promo code: a once-only code became unusable, and a "new customers" code thought they'd ordered | Low | An order cancelled before confirmation, or whose decline the customer's app noted (`DeclineNoted`), doesn't count toward a code's limits, in validation and in the app |
| Points and birth months were public: anyone could read a member's balance, history and birthday month at every store | Medium | No points ledger is published (docs/REWARDS.md). The store works out points from its own private records and checks them at acceptance; grants and birthdays are sealed between the two; the birth month stays on the device |
| One stolen issuer key could mint without limit | High | An issuer issues at most `issuer_daily_limit_cents` in any 24 hours ($20,000 by default), checked on its own chain. A grant in place of a hold's part is exempt: it's exactly that part, collected once |
| Fresh accounts could farm welcome bonuses and new-customer codes without end | Medium | An issuer vouches for an account the first time a card no other account has used pays (`CardAttestation`; the issuer keeps only a hash of the card). Where the network has issuers, welcome bonuses and new-customer codes need it, and stores decline orders without it (`CardNotVerified`) |
| A customer could fill a store's queue with orders they called off before it could answer | Low | After 3 such cancellations at a store in 24 hours, the store's app declines their next orders (`TooManyCancellations`), read from the customer's public chain |
| Long chain walks in validation (a promo's limits over a customer's whole history) | Low | The walk is capped (50,000 actions); past it the order is refused with a plain reason |
| Desktop apps updated themselves from unsigned releases, so whoever could publish a release could replace the app everywhere | High | A build updates itself only when it's signed (`desktop/kangaroo.config.ts`); the workflow passes signing certificates as secrets |
| One key could be both arbiter and issuer: rule for itself, then fund the ruling | Medium | Packaging refuses a network whose arbiters and issuers overlap |

Follow-up review of the same day:

| Finding | Severity | Fix |
| --- | --- | --- |
| A modified customer app could withhold its confirmation, then cancel on the store's accepted version and owe nothing for food it had seen the store start | High | Cancelling on the store's started version is seeing it start (`lineage::saw_start`), confirmation or not -- for the food, the promo's limits and points alike. The stale-branch race that remains costs the store at most `MAX_EARLY_CANCELS` orders before it declines the customer, since it counts every order called off without paying |
| Anyone could crowd a store's grants out of a customer's view with a flood of their own, so the customer's app refused rewards the store would honour | Medium | A store's grants are read by its owner's key, all of them; only gift offers from strangers are capped |
| Disposable virtual and prepaid cards could each verify a new account | Medium | The issuer vouches only for a credit or debit card that passed the processor's checks; a prepaid card neither vouches nor claims the card |
| Validating an issuer's daily limit re-read its whole day per grant, quadratic at volume | Medium | Each grant carries the day's running total, checked against the issuer's previous grant alone. The limit is per UTC day, so a burst either side of midnight can reach twice it in 24 hours |
| Anyone could attach birthday shares under a store, and its sweep read and opened them all | Low | The sweep looks up only its own members who've bought there, by their keys, at most 200 a sweep in turn, and keeps each month privately once read |
| Order-and-cancel spam spread across many stores escaped each store's own limit | Low | A customer who calls off `max_daily_early_cancels` orders (10) before stores answered, anywhere, can't place another for a day -- checked on their own chain |
| A workflow's third-party actions were referenced by movable tags, and `main`, tags and releases had no protection | Medium | Actions pinned to commits; only the owner can push to `main`, make or move tags, or publish; published releases are immutable; the release workflow writes only drafts, and its signing secrets need the owner's approval each run (`release` environment); outside pull requests run CI only once approved |

Third review of the same day:

| Finding | Severity | Fix |
| --- | --- | --- |
| An issuer's word on a card couldn't be withdrawn: an account verified with a stolen card stayed verified after the chargeback | Medium | An issuer withdraws it when a payment is disputed (`CardRevocation`), and vouches again if it wins; its latest word stands |
| Paying first with a stolen copy of someone's card claimed it, so its real owner could never verify | Low | A disputed payment frees its card for whoever really holds it |
| Verification was lost when an account recovered or moved to a new key | Low | It's read through the account's keys (`lineage`), and the issuer carries it to the next network with the balance |
| The desktop release installed Kangaroo's dependencies without holding to its lockfile, and ran a downloaded source unchecked | Medium | Kangaroo's files are checked against a reviewed hash before anything in them runs, and dependencies install from its lockfile exactly |
| Anyone could write grants to anyone, and birthday shares under any store, storing spam at the network's expense | Low | A grant must cite an order its recipient placed at that store, by its owner; a birthday share, an order its author placed there. Gifts from stores someone has never ordered from are no longer possible |
| A key with a very long day (a busy store's owner ordering as themselves) was refused every order by the network-wide cancel check | Low | Past its walk the network-wide check steps aside; each store's own limit still applies. A first-order or once-only code past its walk is still refused, since unchecked it would cost stores money |
| A store counted a customer's early cancels from its latest 50 orders, so at a busy store they soon fell out of view, and an order queued without its history link never counted | Low | The store reads every order the customer queued there in the last day, by their key, from its active queue (retired links included) and its history alike |
| The map's credit line, a network setting, was inserted as HTML: an operator, or anyone who could change the setting, could run script in every app showing a map | Low | Apps rebuild it from its text and http(s) links alone, escaped (`web/src/lib/places/attribution.ts`); packaging warns of anything they'd leave out |

Cancelling is free until the customer's app has seen the store start, and the app says so by the cancel button. A store that starts cooking before the customer's app has heard back takes that risk itself. Its acceptance reaches the customer's app within seconds, by signal, and the app confirms by itself, so the window is small. Neither side's clock can settle which came first, so the customer's own chain decides.

## 2026-11-04 review: findings and fixes

| Finding | Severity | Fix |
| --- | --- | --- |
| On a device shared between identities, one person's cart (a reward's held points included), checkout and driver settings, guardian names, sent offers and saved address showed to the next, or to a new account; screens kept what they'd read for the last one | High (privacy) | Everything kept for a person is kept under their key (`web/src/store/identityScope.ts`), emptied and read back for whoever signs in, with nothing written for nobody; every screen remounts on a change of identity; caches keyed by the caller |
| A PayPal order is made by the payer, and can name another payee or split the money off: a customer could have a store hold and capture a payment that went to an accomplice | High | PayPal is taken out: the store's agent briefly held only orders paying its own merchant ID, but PayPal was never run against its sandbox, and its approval popup can't open in the desktop app |
| Square and Clover take a saved card's id where a fresh token goes, and the agent passed the payer's token on as given | Medium | Each agent accepts only a fresh token's shape from the card form; saved cards are named by the agent alone |
| A driver's app could settle its pay as soon as the order showed delivered, before the store's delivered decision -- the basis of its pay -- reached it, settling for nothing, once and for all; and an order its store decided never arrived never counted as over, so the driver's collateral never paid the store for the food | High (money lost) | A delivery that arrived, or was said not to, is over for settling exactly when its store has decided which |

Second review of the same day:

| Finding | Severity | Fix |
| --- | --- | --- |
| A store's card pays its driver the whole delivery fee and the tip, passing on the customer's part, and the customer set both: a customer and a driver working together could agree a fee of any size, and the store paid its share (half, by default) -- automatically, where it had saved its card with that driver -- or pass a tip of any size through the store's card on a stolen one, whose charge is reversed after the driver is paid | High (money lost) | Each store sets the most a delivery fee may be (`max_delivery_fee`, the network's default $25), and how big a tip may be: a share of the order, or a set amount, whichever is more (`max_tip_percent`, `max_tip_floor`; at first the whole order, or $10). Validation refuses an order past the store version it cites; the store's acceptance refuses one citing more generous limits than today's; checkout offers no more |
| The dev payment agents' session token (`web/public/dev-payments.json`) was copied into the packaged app if they were running while it built | Low | Packaging removes every dev-only file from the build |

Third review of the same day:

| Finding | Severity | Fix |
| --- | --- | --- |
| A delivery its customer wasn't there to take had no way to end: the driver held the food unpaid, every card hold lapsed after a week, and the store was out the food -- so ordering and not answering cost the store each time | High (money lost, abuse) | A driver who's recorded arriving (which tells the customer) and waited the network's wait (`dropoff_wait_secs`), proved against the time source, can say nobody came (`DeliveryStatus::Unanswered`). The customer can still take it, or say they were there (`Disputed`), which the store decides. The store upholds the driver's word only once the customer's report window has run (validation), and it's paid as delivered: the customer pays, the driver is paid, and it counts against the customer (`NoShow`). Sided with, the customer pays nothing and the driver's collateral pays for the food |
| A pickup nobody collected had no way to end either, and its card hold lapsed | Medium (money lost) | Past the collection window from its being ready, proved, the store records it uncollected and keeps the food's price, counted against the customer |
| A customer could block that by saying they couldn't get it, take the food, and never confirm: the store could only cancel, unpaid, and an unanswered report stood forever | High (free food) | A customer can say so once per order (validation). The store decides: it cancels with no charge, or says it's ready, which restarts their window; its conductor gives that answer when it hasn't within its grace. Silence alone charges nobody: only the store recording it uncollected does. A customer who was never given their food has the store's contact details, the record of their report, and their card issuer |
| A scheduled order whose customer's device was offline at its time was sent whenever it came back -- dinner at breakfast | Low | Its app sends it only within half an hour of its time; later, it's called off (`ScheduleMissed`), and nobody owes anything |
| "Cancelled by them" was a reputation event nothing recorded | Low | The store records it when it keeps the food of a customer who never came, for a pickup or a delivery they chose to collect |

Fourth review of the same day:

| Finding | Severity | Fix |
| --- | --- | --- |
| A store keeping a customer's card could charge it from its own dashboard, even after leaving HandShake, and the customer had no way to remove it | Medium | Customers keep no card: validation refuses it, and they pay each time. A store's and a driver's card kept with each other has an end: forgetting it, or six months unused, makes validation refuse it, and the payee's agent deletes it from its processor |
| A standing order placed itself and charged a kept card whenever its customer's device next ran, however late: Monday's lunch could be ordered on Wednesday night | Medium | A recurring order never orders. At its time it asks its customer, who confirms and pays at checkout; half an hour late it's marked missed, with nothing ordered or charged |
| A driver's "nobody came" rested on a location they record themselves, and the customer had no way to see how far off it was. The store deciding a dispute saw neither | Medium | A door photo is required. The customer's app compares the recorded arrival with their drop-off point and says when it's far. On a dispute the store gets the photo from the driver and the distance from the customer, sealed to it (`ArrivalEvidence`), never coordinates |
| A store could raise its own rating with second accounts that only ever order from it | Medium | A store's rating counts a review only once its author has also rated an order from another owner's store (`ReviewerToReview`, whose tag validation holds to the rated order's real store owner). The rest are shown, and the store page says how many aren't counted |

## Store contact details and pickup chat

- **Contact links can only be what they say.** A store's email must be a plain address (letters, digits and `._+-'`, so a `mailto:` link can't carry `?cc=` or anything else), and its website an `http(s)://` address with a real host. No `user@` before the host, which could dress one site up as another. No characters that could break out of a link. Validation holds every peer to this (`handshake_integrity_support::contact`). The app builds every link only from details that pass (`web/src/lib/storefront/contact.ts`), a phone link from its digits alone, and directions from the store's coordinates.
- **Pickup chat is between the order's customer and its store**, as delivery chat is between the customer and the driver (`live_counterpart`). A location is accepted only from a delivery's driver. Chat is never stored. A panel keeps at most 200 lines, and it hears only while that order's screen is open, so nobody can push messages to a closed app.

## What remains

- **The store decides disputed deliveries.** A store could side with a customer against a driver who did deliver, by deciding an order never arrived. It gains nothing (it's paid for the food either way), and the decision is public and recorded against the driver, but the network can't overturn it. A driver is fully protected by completing the delivery with the customer's code or confirmation before the claim is decided.
- **The store's app keeps the report window on its own clock.** A store that settles early, before reports come in, or declines reports unfairly, answers to its reviews; the refund can never exceed what's reported.
- **Left at the door is the customer's risk.** A drop-off left there completes the delivery; a dishonest driver could photograph the wrong door. The photo and location are sealed to the customer, and stores can limit which orders may be left.
- **Who orders from whom** is visible to anyone reading an order's public fields, as is a customer's ~1 km drop-off area. A driver's reads of the open-order lists for an area are seen by the peers that store those lists. See DEVELOPMENT.md, "Personal data".
- **A lost key can't be stopped.** Nothing peer-to-peer can prove a key is gone, so a recovered account's old key stays valid on the network. Honest apps refuse it. There's no balance for it to spend: a store or driver connects their processor account again on the new key, and revokes the old device's processor keys from their processor's dashboard. See RECOVERY.md for the whole model and its residual risks. A hand-over, by contrast, closes the old key's chain.
- **An account's key can leave its device -- only to the person's new phone.** Keys are made exportable so an account can move to a new phone with its key (RECOVERY.md). Only the runtime's native code can export one, never the app's UI, and only sealed to a one-time key in the new phone's keystore, whose fingerprint the person checks on both screens. A photo of the code is useless without that keystore. Someone who can already drive the device's keystore could export the key, but they could sign as the account anyway. The old phone stops before the key leaves: two phones writing as one account would fork it, and the network locks a forked account (it comes back by recovery).
- **A store or driver can wake its customer for nothing.** The wake tokens an order carries (MOBILE.md) let them wake the customer's app without changing the order -- up to the push relay's limits (a few a minute, so many a day), until the token expires. A wake says nothing, so it only annoys; a customer who's being spammed turns waking off and on, which voids every token they've handed out.
- **Reviews from colluding identities.** A store's second identity counts toward its rating only after rating a real order from another owner's store. Someone running two stores, or buying from a stranger once per identity, can still clear that, at the cost of real orders; it raises the price rather than detecting them. A customer's reviews can be listed by their key, as anything on their public chain already could be.
- **Arrival evidence is each side's word.** A driver's location comes from their own device, and the distance is worked out by the customer's app, so a modified app can misstate either. The store sees whose each is, and a store still decides the dispute (see above).
- **Orders assigned but not yet picked up** are limited by the customer's app, which reads the driver's queue before accepting a bid; validation can't see a driver's other assignments. What a driver actually carries is enforced by the network. A customer could retire an order from its driver's queue to understate their load to other customers, but not what the driver can pick up.
- **A store that won't check a driver in** can't be told from a driver who never came, so the network sides with the store: a driver who then leaves an order it says it cooked pays for it if no other driver comes. Drivers report it (`CheckInRefused`, moving no money), the reports show on the store's record, and drivers' auto-bid skips reported stores, so a store that does it loses its drivers.
- **A store's own times are its word**: the ready time it starts and the check-in it records. A store dating its cooking early only brings its own late deadline nearer; a driver's due time always allows their own travel time from when the store confirmed them.
- **Liveness rests on the store's app**: it confirms drivers, moves late ones on, records collect requests and ends orders no driver came for. A store that's offline stalls its own orders; a spiteful one can hold a driver's collateral it isn't owed (it gains nothing by it).
- **A payee could charge a held or saved card more than it's owed.** Processors can't know HandShake's rules. Every rightful charge has a signed settlement on the network, so anything beyond it is a clear chargeback for the payer, and the store's or driver's processor account answers for it. Customers keep no cards, so this is a hold for them. A store and a driver can keep cards with each other, opt-in, per payee. Forgetting one binds the network and an honest agent, but not the processor account: a payee can still charge a card from its own dashboard, or edit its agent to keep it, and HandShake can't remove it for them. The payer's bank can stop it, with the withdrawal on record.
- **An arbiter's award isn't enforced centrally.** The store's agent refunds it; a store that turns its agent off doesn't. The public ruling is the customer's evidence for a chargeback.
- **One card per first-order deal rests on the store's agent**: its processor's card fingerprints, kept on the store's device. A store that loses that device's state could let a card take its deal again; on the network a first order is still one per account.
- **Square and Clover adapters haven't yet run against their sandboxes**, nor the card forms inside the desktop app. Stripe's has, in test mode.
- **Validation reads a customer's history by walking their whole chain** -- Holochain validation can't pick out one entry type -- so the checks that need it (a promo's limits, the daily cancel allowance) stop at a bound. A key past it can't use limited promos; the cancel allowance steps aside for it.
- **Timestamps** still decide store response windows, scheduled orders and promo expiry. An author can backdate within their own chain's history. The store's acceptance check bounds the promo case.
