# Reputation and ratings

How HandShake records what people did and what people thought, who sees it, what it changes, and how anyone answers it. A mark against someone shapes who takes their orders and who they're matched with, and those effects compound. On a network with no company to complain to, the rules themselves have to be fair, visible and answerable.

This is the plan as well as the record. Phases 1 to 3 are built; phase 4 is deferred.

## Two kinds of signal

- **Reputation** is implicit. Nobody chooses to leave it. The app records it as a side effect of something that happened on an order, and validation checks that each event cites the order record or decision it rests on (`reputation` integrity, `validate_event`). It's shown as counts and rates.
- **Ratings** are explicit: stars and a comment someone chooses to leave. Validation checks who may rate (an order's customer, once per order and target) and nothing about whether the opinion is fair.

"Implicit" is not the same as "objective". A reputation event is only as objective as the fact behind it:

| Anchored to | Examples | Who could be wrong |
|---|---|---|
| The order's own records | completed, dropped before pickup, collateral forfeited | nobody: validation checks it |
| A party's decision | no-show upheld, a "never arrived" claim decided | the store that decided -- recorded as its decision |
| A party's word only | "this store wouldn't check me in" | the reporter -- so it moves no money, and counts only from drivers who've delivered for several stores (`min_reporter_stores`) |

## Principles

Every mark, existing or proposed, is held to these.

1. **Anchored.** A mark cites the order action it rests on. No free-floating scores, and nothing derived that can't be traced back to records anyone can read.
2. **Seen by its subject.** Whatever others see of you, you see too, in the same words, with how it's counted. Nothing is shown about you that isn't shown to you.
3. **Answerable.** A mark that rests on someone's decision or word can be answered: an appeal that can overturn it, or a reply shown beside it.
4. **Costly to accuse.** A one-sided mark is allowed only where the one making it pays or risks something -- a refund given, a decision that can be appealed.
5. **Proportionate.** Marks weigh; they never bar. Nobody is blocked from ordering, bidding or selling by their record. Everything is counted over the network's reputation window (`reputation_window_days`, a year by default), so it recovers as you keep going.
6. **Opinion apart from record.** Stars are shown, never weighed: they don't change how bids count or who's matched.
7. **Least exposure.** A mark is shown where it matters to a decision, not everywhere. A customer's report history matters to the store answering a report, not to a driver choosing an order.
8. **Rates over counts, once there's enough to say.** "2 of 40" and "2 of 2" are different people.
9. **Discretion is never a mark.** A choice someone is free to make -- a store declining a refund, as any local shop may -- says nothing about the other party, and recording it would make every "no" an accusation. Only a fact (the order's records, a decision validation holds to proof) or an independent finding (an arbiter's) can mark someone. That's why a contested "never arrived" claim counts: the store's decision rests on proof the order was delivered, which validation checks.

## What exists

| Whose | Marks | Recorded by | Seen by others | Seen by themselves | Changes |
|---|---|---|---|---|---|
| Driver | completed, dropped, offers lapsed, disputes raised, disputes decided against them, collateral forfeited, deliveries held at fault (phase 3); stars | the order's store or customer, citing the order | customers choosing a bid, and on "your driver" | completed, dropped, disputes and decisions against them, under Earnings, with how it's counted; stars on their dashboard | automatic matching weighs drops and lapses (`clean_start_deliveries` cushions newcomers); stars never |
| Store | completed, called off, kept drivers waiting, drivers' check-in reports; stars and reviews | the order's customer or driver, citing the order | customers on its page and info; drivers on each order, and automatic bidding skips stores reported often | **stars only** (gap) | drivers' choices; nothing automatic but a driver's own skip rule |
| Customer | contested "never arrived" claims decided against them, no-shows, orders called off once the store had them; stores' findings of bad faith (phase 2) | the order's store, citing its decision; or the customer's own app, on the order's record of their cancellation | stores and drivers on each order they're handling | **nothing** (gap) | stores' and drivers' choices; nothing automatic |

## Gaps, and what closed them

1. **Customers and stores couldn't see their own record**, though others judged them by it (principle 2). Closed by phase 1.
2. **Reports made in bad faith left no trace.** A store's decline can't be the signal -- it's the store's discretion (principle 9) -- so phase 2 records only an explicit, reasoned finding, held to the guards below.
3. **A poor delivery left no mark on the driver** but the customer's own unverified stars, and the store that paid the refund had no way to say the driver caused it. Closed by phase 3.
4. **Nothing could be answered in place.** Phases 2 and 3 let the one a finding is about reply beside it. An appeal can still overturn a finding about a customer.

## Phase 1 -- everyone sees their own record (built)

App only: no network change, nothing new published.

- **Customers:** "Your record" on their Profile -- exactly the lines stores and drivers are shown, a clear "nothing on your record" when there's none, and how each is counted and how long it lasts.
- **Stores:** "How drivers and customers see you" on the store's page, under its stars -- the same lines customers and drivers see, with how each is counted.
- Drivers already have theirs, under Earnings.

## Phase 2 -- a store's finding of bad faith (built)

A store declining a report is its discretion (principle 9): never recorded, never shown. A store that believes a report about items wasn't made in good faith can say so -- separately, deliberately, with a reason -- and that statement is held to the same guards as any one party's word about another (like drivers' check-in reports):

- **Mark:** `BadFaithReport { reason }` on the customer, recorded by the order's store, citing its own `IssueResponse` declining that customer's report. Validation: only the order's store; only on a report about items (never one about the delivery, which the store didn't see); only on one it declined. The coordinator makes it once per report.
- **A reason, never prose:** `BadFaithReason` is a fixed list (the item was in the order; the photo or note didn't match; the same claim again and again; another reason). Nothing free-written about anyone is published.
- **Counted only from established stores:** a store's findings count once it has `min_flagger_orders` completed orders (default 20) from `min_flagger_customers` different customers (default 10), its owner's own completions excluded -- a store just opened, or opened to flag, counts for nothing.
- **Counted by store, not by flag:** the summary's `bad_faith_stores` is how many different established stores have found against the customer. One store flagging every order counts once.
- **Shown only from `min_flagging_stores`** different stores (default 2), and only to a store answering that customer's report about items -- never to drivers, never elsewhere. One store's view never follows a customer.
- **Overturned by an appeal:** a finding on an order whose appeal the customer won (any award) stops counting, read when counted -- nothing is rewritten.
- **The customer sees every finding**, counted or not, on their own record, with the reason, and can reply once (`MarkReply`), publicly, shown beside it.

## Phase 3 -- store-confirmed driver fault (built)

- **Mark:** `DeliveryFaulted { reason }` on the driver, recorded by the order's store, citing its own `IssueResponse` accepting -- so refunding -- the customer's report on the delivery (`ItemIssue::service`). Validation: only the order's store, only on a report about the delivery, only one it refunded, only against the driver who delivered it.
- **Costly to accuse:** the store has paid the customer out of its own takings before it can say the driver caused it. It gains nothing by blaming the driver.
- **Evidence the driver can read:** a report on the delivery is sealed to the driver as well as the store (`sealed_for_driver`), and the customer is told before they send it. The store's app offers the finding only when the customer said what went wrong, so the driver has something to answer.
- **A reason, never prose:** `FaultReason` (late; cold or spilled; left in the wrong place; rude or unsafe; another reason).
- **The driver answers:** one public reply (`MarkReply`), shown beside the finding wherever it's shown.
- **Shown, never weighed:** customers choosing a driver see "N deliveries held at fault", opening onto each reason and the driver's reply. It never changes the driver's pay or how automatic matching counts their bids.

## Phase 4 -- drivers and stores rating customers (deferred)

Free stars are the most subjective signal and the easiest to use against someone (a driver marking down a customer who didn't tip). If it's built at all: one thumbs-down with a reason from a fixed list, one per order per party, shown as counts, never an average, never weighed. Deferred until phases 1--3 have shown how marks are used.

## Abuse to weigh, phase by phase

| Phase | Abuse | Held by |
|---|---|---|
| 2 | a store declines honest reports to tarnish a customer | declines are never recorded; only an explicit finding with a reason is |
| 2 | one store with a grudge | counted once per store, however often it flags; shown only from two stores |
| 2 | stores opened, or second accounts, to flag | only established stores count: 20 completed orders from 10 different customers, the owner's own excluded |
| 2 | a finding that was wrong | the customer sees it and replies; an appeal they win stops it counting |
| 3 | a store blames a driver falsely | only after refunding the customer; the driver sees the claim and replies |
| 3 | a store and customer collude against a driver | the store pays the refund every time; the driver's reply; reviews from colluding identities already discounted |
| 3 | a driver retaliates | drivers can't mark customers (phase 4 deferred) |
| all | fake accounts flooding marks | each mark is tied to a real order, once per recorder per order; reporters who haven't worked with several parties don't count where that's possible (`min_reporter_stores`) |

## Testing each phase

- Integration (`tests/tryorama/src/reputation-findings.test.ts`): each finding refused from anyone but the order's store, on the wrong kind of report or answer, or twice; a store's finding counting only once it's established, and not once an appeal the customer won; a reply only from the one it's about, once and short; the driver reading the customer's evidence.
- Unit: each display rule -- rates, minimums, the window.
- Browser: each record shown to its subject, in the words others see, at phone and desktop widths, larger text and high contrast.
