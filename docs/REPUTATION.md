# Reputation and ratings

How HandShake records what people did and what people thought, who sees it, what it changes, and how anyone answers it. A mark against someone shapes who takes their orders and who they're matched with, and those effects compound. On a network with no company to complain to, the rules themselves have to be fair, visible and answerable.

This is the plan as well as the record. Phase 1 is built; later phases are proposals, to be built one at a time.

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
| Driver | completed, dropped, offers lapsed, disputes raised, disputes decided against them, collateral forfeited; stars | the order's store or customer, citing the order | customers choosing a bid, and on "your driver" | completed, dropped, disputes and decisions against them, under Earnings, with how it's counted; stars on their dashboard | automatic matching weighs drops and lapses (`clean_start_deliveries` cushions newcomers); stars never |
| Store | completed, called off, kept drivers waiting, drivers' check-in reports; stars and reviews | the order's customer or driver, citing the order | customers on its page and info; drivers on each order, and automatic bidding skips stores reported often | **stars only** (gap) | drivers' choices; nothing automatic but a driver's own skip rule |
| Customer | contested "never arrived" claims decided against them, no-shows, orders called off once the store had them | the order's store, citing its decision; or the customer's own app, on the order's record of their cancellation | stores and drivers on each order they're handling | **nothing** (gap) | stores' and drivers' choices; nothing automatic |

## Gaps

1. **Customers and stores can't see their own record**, though others judge them by it. (Principle 2.)
2. **Reports made in bad faith leave no trace.** A store's decline can't be the signal -- it's the store's discretion (principle 9) -- so the only fair signal would be an independent finding.
3. **A poor delivery leaves no mark on the driver** but the customer's own unverified stars. The store, which pays the refund, has no way to say the driver was at fault.
4. **Nothing can be answered in place.** An appeal can change money, but no record shows "contested" or a reply beside a mark.

## Phase 1 -- everyone sees their own record (built)

App only: no network change, nothing new published.

- **Customers:** "Your record" on their Profile -- exactly the lines stores and drivers are shown, a clear "nothing on your record" when there's none, and how each is counted and how long it lasts.
- **Stores:** "How drivers and customers see you" on the store's page, under its stars -- the same lines customers and drivers see, with how each is counted.
- Drivers already have theirs, under Earnings.

## Phase 2 -- reports made in bad faith (proposed, revised)

A store declining a report is its discretion (principle 9), so a decline is never recorded against a customer, and a store answering a report sees nothing about past declines.

- **Only an independent finding marks:** an arbiter ruling on an appeal may find, separately from the award, that the claim was made in bad faith (a flag on the `Ruling`). That finding alone records a mark on the customer, citing the ruling.
- **A dismissed appeal isn't a mark:** an award of nothing means the arbiter sided with the store, not that the customer lied -- so nobody is deterred from appealing honestly.
- **Rare by design,** and shown to stores answering a report and on the customer's own record.
- **Or not at all:** the customer's record keeps only the factual marks it has today. To decide before building.

## Phase 3 -- store-confirmed driver fault (proposed)

- **Mark:** `DeliveryFaulted`, recorded by the store on the order's driver, citing its own answer to a report on the delivery itself (`ItemIssue::service`).
- **Costly to accuse:** validation allows it only when that answer refunded the customer something -- the store has paid real money for the poor delivery before it can say the driver caused it. A store gains nothing by blaming a driver falsely.
- **The driver sees the claim:** the customer's note and photo are sealed to the driver as well as the store, for a report on the delivery, so the driver knows what they're answering.
- **The driver answers:** a short public reply, once, shown beside the mark wherever it's shown.
- **No money moves.** The refund was the store's. The mark is shown to customers choosing a driver, as a rate of deliveries. It isn't weighed by automatic matching at first -- that waits until there's data to show it's fair.

## Phase 4 -- drivers and stores rating customers (deferred)

Free stars are the most subjective signal and the easiest to use against someone (a driver marking down a customer who didn't tip). If it's built at all: one thumbs-down with a reason from a fixed list, one per order per party, shown as counts, never an average, never weighed. Deferred until phases 1--3 have shown how marks are used.

## Abuse to weigh, phase by phase

| Phase | Abuse | Held by |
|---|---|---|
| 2 | a store declines honest reports to tarnish a customer | declines are never recorded |
| 2 | an arbiter's finding used carelessly | a separate, explicit finding, apart from the award; arbiters are named by the network and their rulings are public |
| 3 | a store blames a driver falsely | only after refunding the customer; the driver sees the claim and replies |
| 3 | a store and customer collude against a driver | the store pays the refund every time; the driver's reply; reviews from colluding identities already discounted |
| 3 | a driver retaliates | drivers can't mark customers (phase 4 deferred) |
| all | fake accounts flooding marks | each mark is tied to a real order, once per recorder per order; reporters who haven't worked with several parties don't count where that's possible (`min_reporter_stores`) |

## Testing each phase

- Integration (`tests/tryorama`): every mark refused from anyone but its recorder, without its anchor, twice, (phase 2) without the arbiter's finding, or (phase 3) without a refund.
- Unit: each display rule -- rates, minimums, the window.
- Browser: each record shown to its subject, in the words others see, at phone and desktop widths, larger text and high contrast.
