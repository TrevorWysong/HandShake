# Running HandShake: what has to stay up, and what to do when something doesn't

HandShake has no central server. That moves responsibility to the people on the network, chiefly the stores. This page is for whoever runs a network (its bootstrap and relay servers, its push relay) and for stores: what has to keep running, what each failure looks like, and what to do about it. SECURITY.md says what the network enforces; this says what people have to do.

## What has to stay running

| Part | Why it matters | If it stops |
| --- | --- | --- |
| **A store's app** (desktop, or an always-on device) | It accepts orders, checks drivers in, moves late drivers on, decides reports and settles every order, and its payment agent holds and charges cards. | Its own orders stall: not lost, but not moving. Customers see the order waiting; deadlines run and the network's rules decide what happens when the app comes back (ORDER_STATES.md). |
| **The store's payment agent** (inside its app) | Holds, charges, releases and refunds on the store's own processor account. | Holds wait. A card authorization lapses after about seven days uncharged: the store isn't paid for that order. |
| **Bootstrap and relay servers** (DEPLOYMENT.md) | How apps find each other and reach each other behind NATs. | Apps already connected carry on; new ones can't join, and some can't reach others. |
| **The push relay** (`push/`) | Wakes closed phone apps when an order changes. | Phones only learn of changes when opened. Nothing is lost. |
| **Other people's apps** | They hold the network's data. A device restored or moved needs two of them online to restore from (RECOVERY.md). | On a live network there are always some. A tiny one can stall restores. |

**For a store, treat an always-on app as part of opening.** A store that closes its laptop at lunch stalls its lunch orders. The desktop app runs its background work while it's open, not while the machine sleeps: keep it open and the machine awake during opening hours, on power and a wired or reliable connection.

## When something is lost

### A store's device is lost, but its key isn't (it moved to a new phone)

Nothing is lost. The account moves with its key (RECOVERY.md, "Moving to a new phone"). Its orders, ratings, rewards, deal cards and payment agent all carry on. Move only when nothing is mid-handover; the app refuses to send the key until the network holds everything the old device wrote.

### A store's key is lost (recovery onto a new key)

The account carries on as a new key with authority to speak for the old (RECOVERY.md, "Recovery"), and its stores move to the new key (`move_store`). What carries:
- the store, its menu and promos, its ratings, its rewards program;
- members' points, gifts included once each member's app shows them (REWARDS.md);
- the cards that took its first-order deal (DIRECT_PAYMENTS.md).

What doesn't, and why. Both are the price of never charging twice, and stores should know them in advance:
- **Orders the old key hadn't decided.** A decision only the old key could make (accepting, settling a report) can't be made by the new one. Those orders end by the network's deadlines.
- **Holds the old key placed but hadn't charged.** The new key can't settle on the old one's behalf, so those authorizations lapse uncharged. The store isn't paid for them; customers aren't charged.

**Before relying on recovery for a business:** set up both a recovery phrase and guardians, and keep the phrase offline. A recovery phrase can authorize a successor on its own. Anyone holding it can take the account over, and two takeovers with one phrase leave honest apps refusing both until it's sorted out. Treat the phrase like the keys to the shop.

### A driver's device is lost

As for a store: a move keeps everything. After a lost key, deliveries in hand end by the network's deadlines, and holds on the driver's own collateral lapse uncharged.

## When something goes down

| What | What people see | What to do |
| --- | --- | --- |
| **The store's processor** (Stripe, Square) | Payments show as waiting or "trouble" in the store's Payments screen; nothing is charged twice. Every request has a deadline and an idempotency key, so a retry is the same request. | Nothing, usually: the agent retries each round. If it lasts, check the processor's status page. Authorizations still lapse after about seven days. |
| **The network's relay or bootstrap** | New apps can't join; some can't reach each other. | Restart them (DEPLOYMENT.md). They hold nothing that needs restoring. |
| **The push relay** | Phones aren't woken. | Restart it. Its database holds devices' push addresses only, readable by its own service account alone. |
| **A store's internet** | Its orders stall, as if its app were closed. | Bring it back; everything resumes where it left off. |
| **A store's payment agent refuses to start** ("Another payment agent is already running for this account") | Two copies of the app, or a stale one, for the same identity. | Close the other copy. One agent per identity is enforced so the same card is never held twice. A copy that crashed leaves nothing in the way. |

## What to watch

On the store's side, its app shows it all; nobody else can see its money.
- **Payments screen: "trouble"** lists payments the agent couldn't work out or carry out this round, with why. One that stays is worth a look before its authorization lapses (about seven days).
- **Reports and disputes**: answered within the network's windows (`answer_grace_secs`, `report_window_secs`, DEPLOYMENT.md), or the network decides by default.
- **Appeals**, where a network has arbiters: answered within `appeal_window_secs`.

On the network's side:
- relay and bootstrap up, and reachable from outside;
- the push relay's `/health`, and its logs for channels failing;
- disk on the push relay's host (it's one small SQLite database).

## What the network does and doesn't guarantee about money

Customers and stores should hear this plainly. The app's words say no more than this, and nowhere promise more.
- **The network fixes the amounts.** What's due on every order, and who's entitled to it, comes from records the network validates, and a store's agent captures only that.
- **Card payments stay between a payer and a payee's own processor.** The network can't stop a payee charging a held card outside HandShake, or force a refund it owes. What it gives the payer is a signed record of what was agreed and decided, which is evidence for a dispute with their card issuer. Holds are not escrow.
- **A store whose app stays off delays its own customers' refunds,** as it delays everything else: the record of what's owed stands, and settles when it's back.

## Rehearse before real orders

Before a store takes real money, walk through each of these once on a test network, with the people who'd do it for real:
1. **Close the store's app mid-order**, and open it again: the order carries on.
2. **Move the store to a new phone** (RECOVERY.md), and take it back before the new phone finishes. Then move it for real.
3. **Recover the store onto a new key** with its recovery phrase, with an order and a hold in flight, and see what lapses.
4. **Cut the store's internet** during a lunch rush's worth of orders, then bring it back.
5. **Revoke the store's processor key**, see the Payments screen say so, and connect again.
6. **Run two copies of the store's app** for one identity: the second's payment agent refuses to start.
7. **Restart the network's relay and push relay** while orders are moving.
8. **Move to a new version of the network** (MIGRATION.md) with a store and a few members, on a test network.

Each should end with nobody charged twice, and nothing lost that the pages above don't say is lost.

## Before scaling past a pilot

- **Have recovery reviewed independently.** Phrase and guardian recovery (`account_integrity`) are the network's most powerful authority. Conflicting recoveries are detected by honest apps, not prevented by validation (SECURITY.md, "What remains"). Its threat model should be exercised by someone who didn't build it.
- **Square and Clover** take real money only once run end to end against their own sandboxes (`payments/src/adapters/index.ts`, `VERIFIED`; DIRECT_PAYMENTS.md). Until then, only test networks connect them.
- **Desktop releases** are checked as an attacker on the same machine would check them (`desktop/securityCheck.ts`), on every platform, in the release workflow. Publish a draft only once every platform's check has passed.
