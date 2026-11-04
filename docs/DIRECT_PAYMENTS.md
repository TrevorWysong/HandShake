# Direct payments

How money moves in HandShake: straight between the people in an order, on the payees' own processors (Stripe, Square or Clover). There's no issuer, no balance, no credits, no money server, and no cut for anyone running the network. The network decides **who is owed what**, with signed, validated records. Each payee's own device carries that decision out on its own processor account, and nothing else can.

Not legal advice: each store and driver is the merchant of record on their own account, under that processor's terms.

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
| Delivered | food − refunds + customer's fee share + tip | bid + tip | nothing |
| Customer collects it themselves | food − store's fee share | — | nothing |
| Customer cancels before the store cooks, a driver paid for | customer's fee share (passed on) | customer's fee share | nothing |
| Customer cancels once it's cooking | food + customer's fee share | customer's fee share | nothing |
| Store kept the driver waiting (`StoreLate`) | nothing for that driver | the whole bid | nothing |
| No driver came (`NoDriver`), or it never arrived | nothing | nothing | the liable driver's collateral |
| Customer never collected (`NotCollected`) | the food | — | — |
| Store declined, or never answered | nothing | nothing | nothing |

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
- **A processor's refusal:** an authorization the payee's processor refuses for good (a revoked key, say) is declined `Unavailable`, so the payer hears; a passing failure is tried again next round.
- **Card testing:** at most `MAX_ATTEMPTS_PER_ORDER` per order, and `MAX_ATTEMPTS_PER_PAYER_HOUR` per payer, counted per offer before the processor sees it.
- **First-order deals:** when an order takes a store's first-order deal (`newcomer_deal`), a card fingerprint that already took it on another order is released at once and declined `NotEligible`. On the network a first order is one per account; the fingerprint makes it one per card too. The fingerprints are kept in the agent's state on the store's device.
- **The app's surface:** four commands, `status`, `connect`, `disconnect`, `wake` (`window.__HANDSHAKE_PAYMENTS__`). None takes an amount or names a payment, so script in the app's pages can't move money. Connecting or disconnecting also waits for the person's confirmation outside the page (a native dialog on desktop), so script can't redirect payments to another account either. Keys from the app are checked as untrusted: only the processor's own field names, each a short string.
- **Keys:** desktop keeps them sealed with the OS keystore (Electron `safeStorage`; refused where there's none, including Linux's plain-text fallback). Dev keeps them in owner-only files under `.dev/payments/`. Never on the network, never in the app's pages.

| Processor | Keys | Hold → capture → release | Status |
|---|---|---|---|
| Stripe | publishable key + **restricted** key (a full `sk_` key is refused) | PaymentIntent, manual capture → capture `amount_to_capture` → cancel | verified in test mode (below) |
| Square | application id + location + access token | `autocomplete:false` payment → lower, then complete → cancel | written to Square's API docs; not yet run against a sandbox |
| Clover | merchant id + public key + Ecommerce private token | `capture:false` charge → capture → refund uncaptured (voids) | written to Clover's API docs; not yet run against a sandbox |
| Test | none (test networks only) | in memory; `tok_test_0002` declines, `…9995` has insufficient funds, `…3155` asks the bank | used by the seed, dev and tests |

Stripe findings (test mode, 2026-11-03): an authorization's `capture_before` is about 7 days out; `card.fingerprint` is present; an idempotent retry returns the same intent; a partial capture releases the rest and is charged its fee on the captured amount only; a cancel has no balance transaction (free); a SetupIntent and an off-session authorization work; `pm_card_authenticationRequired` gives `requires_action`; over-capture is refused. This API version refuses `payment_method_types` alongside automatic payment methods, so the adapter uses `automatic_payment_methods[enabled]` with `allow_redirects=never`.

Still to verify against the processors' sandboxes: Square and Clover end to end; that a Stripe restricted key with only the permissions it needs is refused `/v1/balance`; the card forms inside Electron; and the content security policy's processor domains (`web/vite.config.ts`, `CARD_FORMS`).

**Ways to pay.** Cards everywhere. Apple Pay and Google Pay with Stripe (inside its Payment Element) and Square (its own wallet buttons, using the account's `country` from its payment profile), wherever the device and the app's domain allow them: a browser that supports them, on a domain registered with the payee's processor. Inside the desktop app (Electron) they don't appear, and cards still work. Clover is cards only. Bank debits, buy-now-pay-later and the like are left out on purpose: they can't be held and released, which every leg depends on. A payer's token is only ever a fresh one from the card form: each agent refuses anything shaped like a saved card's id, since the processors would accept one in its place. A wallet's card is never kept on file with Square; asking to keep one is ignored, and a card a processor won't keep never undoes its hold.

Timing: an authorization lasts about seven days, so a scheduled order is at most five days ahead, and the report window is capped at three days.

## Running it

- **Dev:** `npm run dev:reset` seeds stores and drivers on the test processor; `npm run dev:payments` (in `web/`) keeps everyone's agent running, waking on the network's signals. To try a processor's sandbox, paste its test keys in the app under Profile → Payments.
- **Desktop:** `desktop/payments.ts` runs the agent in Electron's main process, started once the conductor and window are up. It answers the app's own main frame only. Patched in by `desktop/build.ts`, which also lets the processors' card forms navigate their own frames (Kangaroo sent every frame's navigation to the system browser) and signs zome calls only for a window's own page, never a frame in it.
- **Tests:** `payments/` unit tests (`npm test`) cover the engine's crash and retry cases, each adapter's requests, and the agent's checks of what the app passes. The network tests play each payee's agent with `payeeAgent` (`tests/tryorama/src/helpers.ts`); `direct-payments.test.ts` checks exact nets and refuses forgeries.

## Threats, and what stops them

| Who | Tries to | Stopped by |
|---|---|---|
| Customer | underpay or change an amount | amounts come from validated order terms; a hold must equal exactly what's required |
| Customer | test stolen cards through a store | every attempt needs a valid order of theirs; per-order and per-hour caps in the agent; the processor's own fraud checks |
| Customer | farm a first-order deal with new accounts | one per account on the network, one per card fingerprint in the store's agent |
| Payee | record a hold or charge that doesn't match | validation enforces exact amounts and each part's entitlement; a false record only hurts its writer, and an over-charge is a clear dispute with the on-chain record |
| Payee | charge a saved card beyond what's agreed | saving is opt-in per payer and payee, with consent text; every rightful charge has a signed record, so anything else is a dispute the payer wins |
| Anyone | write a payment record for someone else's order or leg | validation checks the author against the order's parties; payment links only by their author, under their own order |
| Anyone | read a card token or a bank challenge | sealed to the counterparty |
| Script in the app | move money, or point a store's payments at another account | the app has no amount, capture or refund commands, and the agent acts only on `payments_due`; connecting or disconnecting an account needs the person's yes in a native dialog the page can't draw or click |
| A stolen computer | use the keys | sealed by the OS keystore; Stripe keys are restricted; keys can be revoked from the processor's dashboard |
| A crash or retry | charge twice | idempotency keys, one hold per leg, one settlement per hold |
| An arbiter's award | go unpaid | the store's agent refunds it (`PaymentRefund`); it's no longer enforced centrally, but the public ruling is the customer's evidence for a chargeback |

Privacy: processors see the amount, the currency and an opaque order tag (`hs_…`), never names, addresses or items.
