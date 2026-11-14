# Reputation and ratings

How HandShake records what people did and what people thought, who sees it, what it changes, and how anyone answers it. A mark against someone shapes who takes their orders and who they're matched with, and those effects compound. On a network with no company to complain to, the rules themselves have to be fair, visible and answerable.

This is the plan as well as the record. All four phases are built.

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
7. **Least exposure.** A mark is shown where it matters to a decision, not everywhere. A customer's report history matters to the store answering a report, not to a driver choosing an order. Least exposure is what the app shows, not what the network hides: every mark is a public record (principle 1), so another app could read it. The app's copy says so wherever it promises who sees what.
8. **Rates over counts, once there's enough to say.** "2 of 40" and "2 of 2" are different people.
9. **Discretion is never a mark.** A choice someone is free to make -- a store declining a refund, as any local shop may -- says nothing about the other party, and recording it would make every "no" an accusation. Only a fact (the order's records, a decision validation holds to proof) or an independent finding (an arbiter's) can mark someone. That's why a contested "never arrived" claim counts: the store's decision rests on proof the order was delivered, which validation checks.

## What exists

| Whose | Marks | Recorded by | Seen by others | Seen by themselves | Changes |
|---|---|---|---|---|---|
| Driver | completed, dropped, offers lapsed, disputes raised, disputes decided against them, collateral forfeited, deliveries held at fault (phase 3); stars | the order's store or customer, citing the order | customers choosing a bid, and on "your driver" | completed, dropped, disputes and decisions against them, under Earnings, with how it's counted; stars on their dashboard | automatic matching weighs drops and lapses (`clean_start_deliveries` cushions newcomers); stars never |
| Store | completed, called off, kept drivers waiting, drivers' check-in reports; stars and reviews | the order's customer or driver, citing the order | customers on its page and info; drivers on each order, and automatic bidding skips stores reported often | **stars only** (gap) | drivers' choices; nothing automatic but a driver's own skip rule |
| Customer | contested "never arrived" claims decided against them, no-shows, orders called off once the store had them; stores' findings of bad faith (phase 2); a score from stores and drivers, and their report pattern (phase 4) | the order's store, citing its decision; or the customer's own app, on the order's record of their cancellation | stores and drivers on each order they're handling | **nothing** (gap) | stores' and drivers' choices; nothing automatic |

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

## Phase 4 -- customers rated, customers' patterns, and blocks (built, from research)

The big apps don't publish customer ratings, but they run them internally, and a fraud team acts on them: the decentralized network has no fraud team and no ban, so the same signals have to be visible to the people deciding -- held to these principles.

### What the platforms do (November 2026)

- **Uber Eats couriers rate the customer**, thumbs up or down, after each drop-off; a thumbs-down asks for a reason from a fixed list, and isn't published. A courier's own score is the share of thumbs-up over their last 100 rated trips, shown once they have 10. "Ratings Protection" removes thumbs-down from people with a pattern of irregular, unfair ratings, and from trips affected by things outside the courier's control (a store's delay). [Uber: delivery ratings explained](https://www.uber.com/us/en/deliver/basics/tips-for-success/delivery-ratings-explained/), [Uber AU: satisfaction ratings](https://www.uber.com/au/en/blog/your-guide-to-satisfaction-ratings/)
- **Uber riders have a rating**, from five trips on, and lose access only well below their city's average, after several warnings -- "a very small number of riders". [WEF on Uber's 2019 policy](https://www.weforum.org/stories/2019/05/uber-will-start-deactivating-riders-with-low-ratings)
- **Uber removes access for false refund claims, promo abuse and duplicate accounts**, and screens customers who abuse ratings or support to get refunds, so their complaints don't count against couriers. [Uber: losing account access](https://www.uber.com/us/en/drive/driver-app/deactivation-review/)
- **DoorDash has no customer rating**, but a Dasher can report a customer (SafeChat), unassign without a penalty, and opt out of future deliveries to them; refunds are denied on "order details and account history". [DoorDash: Dasher safety](https://dasher.doordash.com/en-us/support/safety), [DoorDash community guidelines](https://about.doordash.com/en-us/news/community-guidelines)
- **Instacart shoppers can block a customer** from future batches, and Instacart drops ratings from customers who habitually rate low. [Instacart: a community built on best intent](https://company.instacart.com/shopper-community/our-commitment-to-shoppers-a-community-built-on-best-intent)
- **Refund-fraud signals the industry watches:** repeated "not received" or "damaged" claims on one account, address or card; claims the moment a delivery is confirmed; accounts sharing an address or card. No one signal proves fraud; delivery evidence settles most claims. [Accertify](https://www.accertify.com/industry/quick-service-restaurants/), [BoldDesk](https://www.bolddesk.com/blogs/ecommerce-fraud-signals-detection)

### What HandShake does

1. **Stores and drivers rate the customer**, thumbs up or down, once per completed order each (`CustomerRating`): validation holds it to the order's store or the driver who delivered it, on a version showing it completed, a thumbs-down with a reason from a fixed list (`CustomerReason`: rude or abusive; unreachable at the handoff; unsafe; wrong or missing address details; asked to go off the app; another reason) and a thumbs-up with none, once per rater per order, naming the store when the store rates, and within `customer_rating_days` of the order completing (default 3). There's no reason about tipping: a tip is set before a driver bids. A store rates from its order history; a driver from "How were your customers?" on their dashboard, the deliveries stores recorded for them that they can still rate.
2. **A report is answered, not rated:** on an order the customer reported, whoever the report concerns doesn't rate them on it -- the store, for any report, since it answers each and refunds it out of its own takings, the delivery's too; the driver, for one about the delivery; and neither once they claimed it never arrived. The app refuses; and a thumbs-down from whoever a report is about never counts, whichever came first (`reports_on`), so no clock -- the customer's or the rater's, both of which a modified app can set -- decides anything, and backdating gains nothing. The store answers the report itself, and can record a finding of bad faith (phase 2), which the customer sees and replies to.
3. **A score, not stars:** the share of thumbs-up in the latest rating from each of the customer's last `customer_rating_window` counted raters (default 100), shown once there are `min_customer_ratings` (default 10). One word per rater, so no one store or driver -- a regular, a grudge, or an account made for it -- fills the score.
4. **Only established raters, rating fairly:** judged over `rater_window_days` (default 90), a store counts once it has `min_flagger_orders` completed orders from `min_flagger_customers` different customers, its owner's own excluded (phase 2's test), and a driver once `min_reporter_stores` different stores have recorded their deliveries. A rater who has rated at least `min_rater_ratings` customers (default 10) and given more than `max_rater_down_percent` of them a thumbs-down (default 50) doesn't count. Raters are judged a window's worth at a time, batched. Each check reads the shortest of a day, a week, a month or the rater window that settles it (`settled_each`), so a busy store costs a day of links, not months of them. Whether a rater is established reads the same however short the window, and fairness is judged over at least their latest 50 ratings, so a good day can't wash out the months before it.
5. **The report pattern:** "reported a problem on N of their last M orders · stores accepted K" (`get_report_pattern`) -- reports that were right read as bad luck, only refused ones as a pattern -- over `report_pattern_orders` (default 20), shown from `min_report_pattern_orders` (default 5) to a store answering their report. The orders counted are the customer's own history together with the stores' records of serving them (`CustomerToServedOrder`, written by a store as it accepts an order), so neither a modified customer app nor a store can leave one out.
6. **Who sees it:** the score, with how many of each reason, where stores and drivers decide on an order (`CustomerHistory`); the customer sees exactly that on their record. The app never names who rated them, but a rating is a signed, public link, so a customer who looks can find out -- and both sides are told so. Real anonymity would need ring signatures or blind tokens; instead ratings can't answer a report and close within days.
7. **Choices, never bans by score:** a store's auto-accept can hold orders from customers below a score it picks (`hold_below_customer_score`), declining them as not reviewed if nobody does in time -- and the setting shows how many lapsed that way this week, so holding never quietly becomes a ban by score; a driver's automatic bidding can skip customers below a score they pick. A customer with no score shown is never held or skipped -- no history isn't a low score.

### Blocks

Any party -- a customer, a driver or a store -- can block any other, in any direction. Blocked either way, the two no longer see or deal with each other:

| Between | What stops |
|---|---|
| customer and store | the store's listing names the customers it blocked, so their app leaves it out of Browse and its page says it isn't available; a customer's own block does the same from their own list. Ordering is refused either way, and the store's app declines anything that reaches it anyway (`NotServing`), with nobody charged |
| customer and driver | the orders a customer places after blocking a driver name them, so the driver's feed leaves them out and **validation refuses their bid**; on an order already open, the customer's own list keeps the driver's bids out of sight, out of reach and out of matching. A driver's own block leaves the customer's orders out of their feed and stops their app bidding |
| driver and store | the orders a store accepts after blocking a driver name them, so they're out of the driver's feed and validation refuses the bid; on one already open, the customer's app reads the store's listing and won't show, take or match their bid. A driver's own block leaves the store's orders out of their feed |

- **Carried in the records, never looked up:** a block is in its maker's own list (`SealedBlocks`), the list they manage and lift from: one entry per account, written with its first block, sealed to it and padded to whole boxes, so nobody else learns whom, or -- beyond a step of about seventy -- how many; only that the account has blocked someone at some point, and how often its list changed. Sealed rather than private, so it moves with the account to a new phone. A recovered account, whose old key is gone, starts with none, and a store it moves starts with an empty listing list, so no block is ever left that its maker can't see or lift. Where the other side has to know, it travels in the record it applies to -- an order's `blocked` (its customer's) and `store_blocked` (its store's, added as the store accepts), a store listing's `blocked` -- as salted fingerprints, `sha256(domain || salt || key)` (`handshake_types::block_prints`), with a fresh random salt per record, padded with random fingerprints to 8, 16, 32, 64, 128 or 256 so a list doesn't tell how many are real. Every check is against the caller's own list or the record already in hand: no reads of the network, no polling, nothing cached to go stale. Anyone who knows a person's key can test whether a record names them -- and stores are public -- so the app says a block isn't secret. A list holds the 256 most recent; blocking one more lifts the oldest. A store's checks read its own listing, an order's bid checks the order, and a driver's app holds their own list, changed only by their own block or unblock -- so a poll never walks anyone's chain.
- **Validation:** a block is made only as oneself, or as a store one owns, and lifted only by its maker; an order's and a listing's lists must be well-formed, the customer's set as it's placed and the store's as it accepts, and never changed; and **no bid from someone an order names is valid** -- a modified app writing one is refused by every validator, and warranted.
- **From now on:** a block holds for orders placed or accepted after it -- one already under way carries on -- except that on an order still open, a driver newly blocked by its customer or its store is kept out of sight, out of reach and out of matching (the customer's own list, and the store's listing as it stands), and a store's listing changes at once.
- **Never automatic, never counted, never shown to anyone else.** The blocked party isn't told. Each person and store lists and lifts their own blocks: on their profile, or the store's page.

Not emulated: duplicate accounts. Identities are free here, so a customer with no history shows as new -- "no history yet" is itself what a driver or store weighs, and the payments' established-payer check (docs/DIRECT_PAYMENTS.md) already treats a new payer with care.

## Abuse to weigh, phase by phase

| Phase | Abuse | Held by |
|---|---|---|
| 2 | a store declines honest reports to tarnish a customer | declines are never recorded; only an explicit finding with a reason is |
| 2 | one store with a grudge | counted once per store, however often it flags; shown only from two stores |
| 2 | stores opened, or second accounts, to flag | only established stores count: 20 completed orders from 10 different customers, the owner's own excluded |
| 2 | a finding that was wrong | the customer sees it and replies; an appeal they win stops it counting |
| 3 | a store blames a driver falsely | only after refunding the customer; the driver sees the claim and replies |
| 3 | a store and customer collude against a driver | the store pays the refund every time; the driver's reply; reviews from colluding identities already discounted |
| 3 | a driver retaliates | drivers rate customers only within days of the order, and never once it's reported (phase 4) |
| 4 | a driver rates down customers who didn't tip | tips are set before bidding; no tipping reason exists; raters who rate most customers down don't count |
| 4 | a customer rated down unfairly once | a score over the latest word of 100 raters, shown only from 10 |
| 4 | a store or driver retaliating for a report, review or appeal | ratings close `customer_rating_days` after the order; whoever a report concerns (the store, any; the driver, one on the delivery) never rates the customer on that order, and their thumbs-down never counts there |
| 4 | a customer padding their score with stores or accounts of their own | only established raters count, one word each; it takes many established fake stores, each with completed orders from several customers -- costly, though not impossible while identities are free |
| 4 | a customer reporting every order so they can't be rated | it voids only the rating of whoever the report concerns; the report pattern shows reports and how many stores accepted, and stores can record findings of bad faith, which count for more than a rating |
| 4 | backdating a report, or a rating | nothing to gain: whether a report voids a thumbs-down never depends on when either was written |
| 4 | holding below a score becoming a ban | off by default, the store's own choice, and the setting shows how many held orders lapsed |
| 4 | blocks used to punish | they mark nobody, and are never counted or shown in the app |
| 4 | reading who blocked whom, or how many | a fresh salt per record, so lists can't be matched across records; padded to fixed sizes, so they don't tell how many; only a known key can be tested |
| 4 | blocking as someone else, or bidding past a block | only the person, or the store's owner, can make a block, and only its maker lifts it; a bid from someone the order names is invalid |
| all | fake accounts flooding marks | each mark is tied to a real order, once per recorder per order; reporters who haven't worked with several parties don't count where that's possible (`min_reporter_stores`) |

## Testing each phase

- Integration (`tests/tryorama/src/customer-ratings-and-blocks.test.ts`): a rating refused from anyone but the order's store or driver, without its reason, without naming the store, off a completed order, twice, or by whoever a report on it is about; a rater who rates most customers down not counting; the report pattern and `reports_on`; a block refused when made as someone else; a store's listing naming the customers it blocked, padded, so ordering and accepting stop, lifted only by the store; a customer's own block stopping their ordering; a customer's block keeping a driver off an open order and carried by the next, out of the feed, refused by their app and **by validation**; a store's block carried by the orders it accepts.
- Integration (`tests/tryorama/src/reputation-findings.test.ts`): each finding refused from anyone but the order's store, on the wrong kind of report or answer, or twice; a store's finding counting only once it's established, and not once an appeal the customer won; a reply only from the one it's about, once and short; the driver reading the customer's evidence.
- Unit: each display rule -- rates, minimums, the window.
- Browser: each record shown to its subject, in the words others see, at phone and desktop widths, larger text and high contrast.
