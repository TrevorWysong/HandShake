# Trust from real connections

A design for weighing who rates whom by how they connect to the rest of the network, so a cluster of made-up stores and accounts counts for little, however many ratings it writes. Not built yet: this is the plan to build from.

## Why

docs/REPUTATION.md phase 4 counts a customer's score only from established raters, one word each. That raises the cost of padding a score with stores and accounts of one's own, but doesn't end it: identities are free, so enough fake stores, each with completed orders from fake customers, become "established". Nothing about a single rater tells a real store from a well-made fake one.

What does tell them apart is how they connect. A fake cluster can make as many orders among itself as it likes, but it can't make a **verified driver** -- a real, background-checked person, verified by the network's verifiers -- carry them. Every delivery a verified driver makes is a real connection to the honest network, and the one thing a cluster can't mint. This is the idea trust-graph systems (SybilGuard, SybilRank, Advogato) build on, shaped for a network nobody holds whole.

## What a platform would do here

A large delivery platform computes trust centrally: one database, the whole graph, a nightly job. Here nobody holds the graph, every hop is a network read, and every device must reach the same answer. The same goals, under those constraints, give three rules:

1. **Decide at write time, not on read.** A connection is recorded once, when it happens, as a record the network validates -- never rediscovered by walking the graph each time a score is read.
2. **Only what validation can check.** A connection counts only if every validator can confirm it from the records it cites: the order, its delivery, the driver's verification. Nothing a party merely asserts -- an order's total, a payment made off the network -- carries trust on its own.
3. **The same answer everywhere.** A rater's weight follows from records anyone can read, so every device computes the same score, the customer's own included.

## The model

**Verified deliveries, recorded and validated as they happen.**

- **The connection.** When a store records that a driver delivered one of its orders (as it already records the driver's completed delivery), it also files a **verified-delivery link** under the store -- *only if the driver's winning bid cites a standing verification*. The link's tag says which driver and which customer. Validation checks it against the order (delivered, on this bid, at least `trust_min_order`), the bid, and the verification the bid cites. A store can't file one for a delivery that didn't happen, by a driver who wasn't verified.
- **A store rater's weight:** how many *different* verified drivers delivered its orders, for customers other than the one being scored, within the reputation window -- `min(1, drivers / trust_drivers)` (default 3). One read per store, from its own links; batched for a page of raters.
- **A driver rater's weight:** 1 if they hold a standing verification, else 0. On a network with verifiers, the drivers whose ratings count are the ones the network vouched for -- as on any platform, where every driver is checked before their first delivery.
- **The score:** the weighted share of thumbs-up, from the latest word of each rater, as now; "shown" needs enough *weight*, not just enough ratings.
- **The customer being scored is left out.** A delivery to the customer being scored never adds to a store's weight in their score, so the cluster a customer builds around themselves can't lift them through their own orders.
- **Before a network has verifiers** there's nothing to anchor to: scores count as phase 4 does today (established raters, one word each), switching to weighted once `trust_seeded` is turned on.

This is trust one hop from the network's verified drivers -- the hop everyone can check -- recorded as it happens. A second hop (stores vouching for drivers, drivers for stores) would need walking the graph on every read, and add little: on a network with verifiers, its drivers are verified.

## The graph we already have

| Record | Today | Needed |
|---|---|---|
| a store's completed orders, by customer | `StoreToEvent` | -- |
| a driver's completed deliveries, by store | `DriverToEvent` | -- |
| a driver's verification | `DriverVerification`, cited by each bid | -- |
| **a store's deliveries by verified drivers** | -- | **the verified-delivery link**, filed alongside the driver's completion |

## Threats, and what each costs

| Attack | Cost under this model |
|---|---|
| **Fake cluster** of stores and customers rating each other, or one customer, up | each fake store needs real deliveries by `trust_drivers` different verified drivers, for customers other than the one it lifts -- real people, real trips, real fees; a bigger cluster needs proportionally more |
| **Bought edges**: a few real orders placed to connect | an order alone connects nothing; only a verified driver's delivery does |
| **A colluding verified driver** | counts once per store, however many deliveries; the store still needs `trust_drivers` of them; the driver's verification can be withdrawn, ending their weight and their stores' |
| **Cheap orders** to make connections | under `trust_min_order` they don't count; above it, each is a real delivery |
| **Forged connections** | the link is validated against the order, the bid and the verification; a forged one is invalid, and warranted |
| **Partial reads** | a link not yet arrived lowers a weight, never raises it |

## Cost

- **Writes:** one extra link per completed delivery, by the store, in the call that already records it.
- **Reads:** per score, one batched read of the raters' verified-delivery links and one of driver verifications -- the same shape as phase 4's rater checks today. No graph walks, nothing cached, nothing to go stale.
- **Every number a setting:** `trust_drivers`, `trust_min_order`, `trust_seeded`, alongside phase 4's.

## What the subject sees

The same score everyone sees (docs/REPUTATION.md principle 2), with the line "counted from stores whose orders verified drivers carry, and from verified drivers".

## Proving the defaults

A simulation in tests (pure Rust, no conductor): an honest network of realistic shape -- many customers, fewer stores, a share of drivers verified, heavy-tailed order counts -- against clusters of 10 to 1,000 fake identities with 0 to 20 verified-driver deliveries, rings, and a colluding driver. It measures how far a padded score rises, how much honest raters lose, and picks `trust_drivers` on that evidence: clusters must gain nothing without verified deliveries, and honest established stores keep full weight.

## Building it

1. **The simulation** -- the model and its defaults.
2. **The verified-delivery link** -- written with each driver's completion, validated against the order, bid and verification.
3. **Weighted scores** behind `trust_seeded`, with the explanation in the app; phase 4's rule otherwise.
4. **Store verification** later: verified stores become anchors too, letting a driver's weight follow the verified stores they deliver for.

## Decided

Chosen as a large delivery platform would, given a network nobody holds whole:

1. **One score, the same for everyone** -- the customer included. Platforms show customers the rating their merchants and drivers see; here it also has to be what every device computes from the same records.
2. **One hop, recorded as it happens** -- from verified drivers to the stores they deliver for. Two hops would mean walking the graph on every read; a platform here would record the connection once, validated, and read it in one step.
3. **An order of at least $10 equivalent makes a connection** (`trust_min_order`), under a typical small-order threshold -- but it's the verified driver's delivery that carries the cost, since an order's total alone proves no money moved.
