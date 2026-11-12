# Direct payments

How money moves in HandShake: straight between the people in an order, on the payees' own processors (Stripe or Square; Clover is paused, see below). There's no issuer, no balance, no credits, no money server, and no cut for anyone running the network. The network decides **who is owed what**, with signed, validated records. Each payee's own device carries that decision out on its own processor account, and nothing else can.

Not legal advice: each store and driver is the merchant of record on their own account, under that processor's terms.

## What the network enforces, and what it can't

The network enforces the **obligations**: who may hold what on whose card, exactly how much, and how much of a hold each party may capture, on which decision. Every peer checks every record, and a record that breaks a rule is refused. It doesn't see the **charges**. A hold or a settlement names the processor's reference and an amount, written by the payee. Nothing in it is a receipt the processor signed, so the network can't check that the processor did what the record says.

So a payee who leaves the payment agent, or edits it, can charge a card from their own processor dashboard, for any amount, whatever the network records. HandShake is a marketplace of independent merchants with their processors' protections, **not an escrow**. What a payer has instead:

- **The record.** Every hold, settlement and refund is a signed, public record of what the network says they owe. A charge that doesn't match one is a clear case for a chargeback, and the record is the evidence.
- **Their own history.** The Payments screen lists what the network settled, so it can be laid beside a card statement.
- **The processors' own rules.** Stores and drivers are merchants under their processor's terms, which cover unauthorized and disputed charges.

The network never claims to enforce the amount a processor actually charged, and nothing in HandShake should say it does. Reading the processor's own record of a charge, from its webhooks or a receipt it signs, is how this could narrow later. Neither is built.

## The three payments of a delivery

| Leg | Payer → payee | Held for | Held when |
|---|---|---|---|
| **Customer** | customer → store | the food, the customer's share of the delivery fee at their cap (`max_delivery_fee`), and the tip | before the store accepts: placing the order offers the card |
| **Driver pay** | store → driver | the driver's accepted bid and the tip | before the driver commits |
| **Collateral** | driver → store | the food's value | before the driver commits |

A pickup has only the customer leg, for the food. A store ordering from itself pays nothing (a payer is never their own payee). A driver who takes over from one who left has their own driver-pay and collateral legs, since legs are keyed by bid.

**Each hold is captured once, after the order is settled**, for exactly what the network's rules say its payee is owed; the rest is released. A release (void) costs nothing on every processor, and a capture is charged its fee on what's captured only.

| Outcome | Customer leg (store captures) | Driver pay (driver captures) | Collateral (store captures) |
|---|---|---|---|
| Delivered -- or nobody came to the door, upheld (`Unanswered`) | food − refunds + customer's fee share + tip | bid + tip | nothing |
| Customer collects it themselves | food − store's fee share | — | nothing |
| Customer cancels before the store cooks, a driver paid for | customer's fee share (passed on) | customer's fee share | nothing |
| Customer cancels once it's cooking | food + customer's fee share | customer's fee share | nothing |
| Store kept the driver waiting (`StoreLate`) | nothing for that driver | the whole bid | nothing |
| No driver came (`NoDriver`), or it never arrived (a customer's claim the store sided with, a no-show's included) | nothing | nothing | the liable driver's collateral |
| Customer never collected (`NotCollected`): a delivery they chose to collect, or a ready pickup | the food | — | — |
| Store declined, or never answered; a scheduled order its store was closed for, or sent too late (`StoreClosed`, `ScheduleMissed`) | nothing | nothing | nothing |

The store's share of the fee is inside the bid it pays the driver; the customer is held only for their own share. The store passes on the customer's share of the fee and the tip only as the driver actually took them: a store's claim cites the driver's settlement (`Claim.via`).

**Equivalence is tested, not hoped for.** `dispatch_types::direct` is a pure model of every part, and its tests prove that for every scenario, what each party pays and is paid equals the old credits rules, before processor fees.

**Known difference from the credits model.** If a customer cancels after a driver is assigned but before the driver commits, the driver is paid the customer's fee share only if the store's card was already held for them (saved with that driver, so offered automatically at bid acceptance). Otherwise nobody is charged for that driver.

## The records (dispatch zome)

All in `dispatch_types::payments`, validated in `dispatch_integrity::payments`:

- **`PaymentProfile`** (the payee's): processor, its public key (Stripe publishable key, Square application id, Clover public key), Square's location or Clover's merchant, and live or test. It must match the network's `live_payments`. The test processor is refused on a live network. It never holds a secret.
- **`PaymentOffer`** (the payer's): the order, the leg, and a single-use token from the payee's own card form, **sealed to the payee**, or none, meaning "the card I saved with you". At most `MAX_OFFERS_PER_LEG` per leg.
- **`PaymentHold`** (the payee's): the offer it answers, the processor's reference, and an amount that must equal exactly what the network requires. One per leg.
- **`PaymentAction`** / **`PaymentDeclined`** (the payee's): the card's bank wants the payer to confirm (sealed to the payer), or a decline code.
- **`PaymentSettlement`** (the payee's): the hold, what was captured, and the claims for each part, each checked against the order's decisions. One per hold.
- **`PaymentRefund`** (the store's): an arbiter's award refunded from a captured payment.

Order steps are gated on holds: the store accepting cites the customer hold, and the driver committing cites the collateral and driver-pay holds. An honest app can't skip a step, and a dishonest payee only shortchanges itself.

Queries: `payments_due` (what this payee's agent should do, with exact amounts), `my_payments_owed` (what the caller pays on an order, for card forms), `my_payment` (where the caller's payment stands), `order_payments`, `my_payment_history` (earnings, Transparency). A charge reads net of award refunds.

## The payment agent (`payments/`)

It runs only on a payee's device (stores and drivers) and holds their processor keys. Its round:

1. read `payments_due`;
2. do each item on the processor: authorize, resume after a bank challenge, capture, release, refund;
3. record what happened.

- **Idempotency:** every processor call carries a key derived from the network record it answers (`idempotencyKey`), so a round cut short by a crash and run again moves money once. Adapters also treat "already done, for the same amount" as done.
- **One agent per identity:** an agent holds its identity's folder, its state and keys, from start to stop (`lock.ts`). A second one, in this process or another, is refused rather than run alongside, so the same offer is never authorized twice and no state is saved over another agent's. The lock is a line of generations, each put in place whole in one step that fails if it exists already. A process finding the holder dead claims the next generation, and only one can, however many race to take over. Each holder removes only its own. A holder is its process id and when that process started, so an id the system has since given another process reads as the dead holder's. A record that isn't a real holder's (a process id of 0 or below, no token) is damaged, and taken over. A folder is its real path, so a symlink or a `..` can't hold it twice.
- **Deadlines:** every processor request is given up after `PROCESSOR_TIMEOUT_MS` and tried again next round as the same request, by its idempotency key. One hung connection can't stall a round. An answer cut off partway is no answer, never an empty success.
- **Upkeep never blocks what's owed:** uploading old deal cards and expiring saved cards each run on their own. A failure is reported and retried, and payments go on.
- **Processors not yet verified:** a processor takes real money only once its adapter has run end to end against the processor's own sandbox (`adapters/index.ts`, `VERIFIED`). Until then it can be connected on a test network, to try it there. Stripe has been verified; Square hasn't yet.
- **A processor's refusal:** an authorization the payee's processor refuses for good (a revoked key, say) is declined `Unavailable`, so the payer hears; a passing failure is tried again next round.
- **Card testing:** at most `MAX_ATTEMPTS_PER_ORDER` per order, and `MAX_ATTEMPTS_PER_PAYER_HOUR` per payer, counted per offer before the processor sees it. New accounts are free, so cards could be tested across many. Some payers have a history: their card held at this store before, or their public order history shows completed orders with `established_payer_stores` different store owners. Those orders must have been placed at least `established_payer_days` ago, among the payer's last `established_payer_lookback` orders. The zome reads this into each authorization as `payer_established`. Payers with a history are never asked for anything, and their declines don't count.

Declines from the others are counted, and a burst of them (`MAX_NEW_PAYER_DECLINES` in `NEW_PAYER_WINDOW_MS`) makes the agent publish a busy record (`record_busy`, a `PayeeBusy`). While it stands, a payer with no history has to send proof of work with their card. Their app does this automatically: it finds a nonce whose hash, bound to payer, payee and record (`work_bits`), starts with `newcomer_work_bits` zero bits, about a second on a phone. The ask doubles each time the declines double, up to `newcomer_work_max_bits`. Without the work, an offer is declined `WorkNeeded` before the processor sees it, and the app does the work on the next try.

- **For a real newcomer:** never turned away, and never kept waiting behind whoever started the burst. Every newcomer with the work goes through.
- **For someone testing cards:** fresh work for every account and every step up, on top of the per-order and per-payer caps.

This prices card testing; it can't stop a determined attacker with fast hardware, and the payee's processor's own fraud checks stay the backstop.
- **First-order deals:** when an order takes a store's first-order deal (`newcomer_deal`), a card that already took it on another order is released at once and declined `NotEligible`. On the network a first order is one per account; the card makes it one per card too. Each card's claim is kept on the network (`claim_newcomer_card`, a `StoreToNewcomerCard` link from the store to the order). It's tagged with a hash of the processor's card fingerprint, salted with the store's line: the first store of the chain it moved along on this network.
- **The fingerprint stays hidden.** A fingerprint is an opaque id only the payee's processor account issues, never the card's number, so nobody else can work back from the hash.
- **Stores can't be correlated.** Salted, the same card's hashes at two stores never match, even if their processors gave the same id.
- **Moves keep the claims.** No key goes into the hash, so the store's owner finds the claims whichever key they hold. A claim is looked for under every store in the line, so a reset device or a recovery onto a new key forgets nothing.
- **Network moves keep them too.** For a store brought over from the previous network, the new version passes the fingerprint to the previous network's cell on the same device (`newcomer_card_claim`). That cell salts and hashes it as that network does, so the fingerprint never leaves the device.

Claims an older agent kept on its device are uploaded on its next round, then dropped from there.
- **The app's surface:** four commands, `status`, `connect`, `disconnect`, `wake` (`window.__HANDSHAKE_PAYMENTS__`). None takes an amount or names a payment, so script in the app's pages can't move money. Connecting or disconnecting also waits for the person's confirmation outside the page (a native dialog on desktop), so script can't redirect payments to another account either. No key passes through the app's pages: on desktop, connecting names only the processor, and its keys are typed in a window of the main process's own (`desktop/paymentKeys.ts`). Only the dev host takes keys from the page, and a dev network takes test keys only. Keys are checked as untrusted wherever they come from: only the processor's own field names, each a short string.
- **Keys:** desktop keeps them sealed with the OS keystore (Electron `safeStorage`; refused where there's none, including Linux's plain-text fallback). Dev keeps them in owner-only files under `.dev/payments/`. They go only to the payee's own processor, over its API; never onto HandShake's network, to any server of HandShake's, or into the app's pages.

| Processor | Keys | Hold → capture → release | Status |
|---|---|---|---|
| Stripe | publishable key + **restricted** key (a full `sk_` key is refused) | PaymentIntent, manual capture → capture `amount_to_capture` → cancel | verified in test mode (below) |
| Square | application id + location + access token | `autocomplete:false` payment → lower, then complete → cancel | written to Square's API docs; not yet run against a sandbox |
| Clover | merchant id + public key + Ecommerce private token | `capture:false` charge → capture → refund uncaptured (voids) | **paused**: written to Clover's API docs, but not connectable (below) |
| Test | none (test networks only) | in memory; `tok_test_0002` declines, `…9995` has insufficient funds, `…3155` asks the bank | used by the seed, dev and tests |

Stripe findings (test mode, 2026-11-03): an authorization's `capture_before` is about 7 days out; `card.fingerprint` is present; an idempotent retry returns the same intent; a partial capture releases the rest and is charged its fee on the captured amount only; a cancel has no balance transaction (free); a SetupIntent and an off-session authorization work; `pm_card_authenticationRequired` gives `requires_action`; over-capture is refused. This API version refuses `payment_method_types` alongside automatic payment methods, so the adapter uses `automatic_payment_methods[enabled]` with `allow_redirects=never`.

**Clover is paused.** Clover requires every Ecommerce charge and capture to carry the IP address of the payer's browser (`x-forwarded-for`). A payee's device never sees it: the payer's app talks to the network, not to the store. Sending the store's own address would misreport the payer to Clover, and having the payer's app send its address would hand it to their store. Until that's resolved, the agent refuses to connect Clover and the app doesn't offer it. The adapter stays, for when it is.

**One account's payments stay with it.** The agent records which processor account placed each hold (`State.heldWith`), on disk before the network hears of the hold, and settles or refunds it there and nowhere else. Holds placed before the agent began recording this belong to the first account it ran afterwards (`State.legacy`). A change of account waits for any round under way, so a round begun with one account's keys never saves its state over the change. Each start makes the network's payment profile match the keys the device keeps, publishing it or withdrawing it, so a connect or disconnect a crash cut short is put right. Nothing is paid until that succeeds: there's no engine until then, and each tick tries again instead of running a round. Disconnecting forgets the keys before withdrawing the profile, so a crash between the two fails closed. A store that disconnects, or connects a different account, leaves that account's holds waiting, reported as trouble on its Payments screen; they're collected when it connects that account again, or lapse uncharged when the hold expires. Cards payers saved with one account can't be charged by another, so they're dropped when the account changes, and those payers enter a card again. The agent never keeps a disconnected account's keys to finish its payments: disconnecting is how a payee cuts off a key they think is exposed.

Still to verify against the processors' sandboxes: Square and Clover end to end; that a Stripe restricted key with only the permissions it needs is refused `/v1/balance`; the card forms inside Electron; and the content security policy's processor domains (`web/vite.config.ts`, `CARD_FORMS`). The first two are scripted: `npm run sandbox -- stripe` (or `square`) in `payments/`, with the sandbox's keys in the environment (`payments/sandbox/check.ts`). It holds, captures in part, releases, refunds, declines, keeps and forgets a card through the adapter, retries each under its idempotency key, and reads every outcome back from the processor itself. With Stripe it also checks the restricted key is refused the balance, payouts, transfers, webhooks and the rest. It refuses live keys. Square's access tokens can't be narrowed the same way, so Square's least privilege rests on which endpoints the adapter calls.

**Saved cards.** A store or driver paying the other can keep a card with them (opt-in, with consent text): the payee's agent keeps the processor's id for it, under the payer's key, on its own device. The payer's app offers it automatically where their own chain shows they kept one with that payee, and the agent uses it only for an offer that payer made, so no other account is ever charged it. A card is saved with one payee, never across them: each charges through its own processor account, and one card for every store would need a vault someone runs. Device wallets and the browser's card autofill give customers one tap everywhere. A recovered account, on a new key, saves its card again.

**Customers keep no card.** Validation refuses a customer's offer that asks a store to keep their card, or names one it kept: a customer is there to pay each time (a recurring order asks them at its time, below), with Apple Pay, Google Pay or a card form, so no store holds a card it could charge from its own dashboard.

**Recurring orders ask; they never order.** A template lives on its customer's chain. At its time their own conductor signals their app (`RecurringOrderDue`), which reminds them with the order ready at checkout at the current menu's prices. They confirm and pay there. Half an hour past its time it's marked missed (`RecurringDue`), and it's never placed late. Nothing runs for a closed app, and no server holds the schedule: they see it on opening the app.

**A kept card stays the payer's to withdraw.** A store and a driver can keep a card with each other, to save tapping at each check-in. The consent says plainly that the payee's processor holds the card, not HandShake. `forget_saved_card` writes `SavedCardForgotten` on the payer's chain, and from then on validation refuses an offer on that card (`saved_card_with`, walking the payer's own chain). A card unused for `SAVED_CARD_DAYS` (180) is refused the same way. The payee's agent deletes it from the processor on either, handling withdrawals before anything else in a round, so an offer still waiting isn't charged. It dates a card by the offer that kept or used it, on the same clock as the withdrawal, and deletes a card another replaces. The network can't reach into a processor account: a payee who leaves HandShake, or edits its agent, could still charge from its dashboard. The record of the withdrawal, and of no settlement for that charge, is the payer's evidence for a chargeback.

**Ways to pay.** Cards everywhere. Apple Pay and Google Pay with Stripe (inside its Payment Element) and Square (its own wallet buttons, using the account's `country` from its payment profile), wherever the device and the app's domain allow them: a browser that supports them, on a domain registered with the payee's processor. Inside the desktop app (Electron) they don't appear, and cards still work. Clover is cards only. Bank debits, buy-now-pay-later and the like are left out on purpose: they can't be held and released, which every leg depends on. A payer's token is only ever a fresh one from the card form: each agent refuses anything shaped like a saved card's id, since the processors would accept one in its place. A wallet's card is never kept on file with Square; asking to keep one is ignored, and a card a processor won't keep never undoes its hold.

Timing: an authorization lasts about seven days from when it's held, and a scheduled order's is held when it's scheduled. So a scheduled order is at most five days ahead, and the report window is capped at one day: five days, one more to report, and the delivery itself still fit.

## Running it

- **Dev:** `npm run dev:reset` seeds stores and drivers on the test processor; `npm run dev:payments` (in `web/`) keeps everyone's agent running, waking on the network's signals. To try a processor's sandbox, paste its test keys in the app under Profile → Payments.
- **Desktop:** `desktop/payments.ts` runs the agent in Electron's main process, started once the conductor and window are up. It answers the app's own main frame only. Patched in by `desktop/build.ts`, which also lets the processors' card forms navigate their own frames (Kangaroo sent every frame's navigation to the system browser) and signs zome calls only for a window's own page, never a frame in it.
- **Tests:** `payments/` unit tests (`npm test`) cover the engine's crash and retry cases, each adapter's requests, and the agent's checks of what the app passes. The network tests play each payee's agent with `payeeAgent` (`tests/tryorama/src/helpers.ts`); `direct-payments.test.ts` checks exact nets and refuses forgeries.

## Threats, and what stops them

| Who | Tries to | Stopped by |
|---|---|---|
| Customer | underpay or change an amount | amounts come from validated order terms; a hold must equal exactly what's required |
| Customer | test stolen cards through a store | every attempt needs a valid order of theirs; per-order and per-hour caps in the agent; the processor's own fraud checks |
| Customer | farm a first-order deal with new accounts | one per account on the network, and one per card, claimed on the network under a hash of its fingerprint salted per store, across the store's moves and networks |
| Anyone | test cards through a store with throwaway accounts | caps per order and per payer; during a burst, proof of work for every account with no history, doubling as the declines do; customers with a history are untouched and newcomers are never turned away |
| Payee | record a hold or charge that doesn't match | validation enforces exact amounts and each part's entitlement; a false record only hurts its writer, and an over-charge is a clear dispute with the on-chain record |
| Payee | charge a saved card beyond what's agreed, or after it's withdrawn | customers keep no card with anyone; between a store and a driver saving is opt-in, with consent text saying who holds it; forgetting it, or six months unused, ends it on the network and on an honest agent; every rightful charge has a signed record, so anything else is a dispute the payer wins |
| Anyone | write a payment record for someone else's order or leg | validation checks the author against the order's parties; payment links only by their author, under their own order |
| Anyone | read a card token or a bank challenge | sealed to the counterparty |
| Script in the app | move money, or point a store's payments at another account | the app has no amount, capture or refund commands, and the agent acts only on `payments_due`; connecting or disconnecting an account needs the person's yes in a native dialog the page can't draw or click |
| A stolen computer | use the keys | sealed by the OS keystore; Stripe keys are restricted; keys can be revoked from the processor's dashboard |
| A crash or retry | charge twice | idempotency keys, one hold per leg, one settlement per hold |
| An arbiter's award | go unpaid | the store's agent refunds it (`PaymentRefund`); it's no longer enforced centrally, but the public ruling is the customer's evidence for a chargeback |

Privacy: processors see the amount, the currency and an opaque order tag (`hs_…`), never names, addresses or items.
