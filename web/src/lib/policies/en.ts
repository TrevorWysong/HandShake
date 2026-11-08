// The policies page in English -- the source. Each translation (es.ts, ...)
// says the same rules, section for section and point for point
// (test/policies.test.ts holds them to it); keep them in step when a rule
// changes.
import { HANDOFF_CODE_DIGITS, MAX_STORES_PER_OWNER, type NetworkTerms } from "../../holochain/types";
import { formatCents } from "../ui/format";
import { spoken, type PolicyChange, type PolicyContent, type PolicySection } from "./common";

const changes: PolicyChange[] = [
  {
    version: "1.9",
    date: "2026-11-08",
    summary: "Deliveries: once a store hands an order over, to a driver or to its customer, it can't call it off, and a driver who's taken it can't leave it. One picked up that nobody says more of is settled as delivered once the customer's time to say otherwise has run; a customer who never got it can appeal. Drivers choose how far off their way an add-on may be.",
  },
  {
    version: "1.8",
    date: "2026-11-07",
    summary: "Deliveries: one its store goes silent on, while it's the store's turn, can be closed with no charge, and the store pays any driver it had checked in. One picked up that never arrives is reported for you a day on. A customer collecting an order has their full window from when it's due ready.",
  },
  {
    version: "1.7",
    date: "2026-11-07",
    summary: "Pickups: a customer who can't get their order can report it once, and the store decides. If it says the order is ready, they have the same time again to collect it, and pay for it if they don't. A pickup its store goes silent on can be closed with no charge.",
  },
  {
    version: "1.6",
    date: "2026-11-06",
    summary: "Sale prices: a store can lower an item's price for a while or on a schedule.",
  },
  {
    version: "1.5",
    date: "2026-11-06",
    summary: "Allergies: a store says what's in its food, you can keep a sealed list and tell a store at checkout, and what that can and can't promise. Each is its own word, and no flag doesn't mean safe.",
  },
  {
    version: "1.4",
    date: "2026-11-03",
    summary:
      "Payments go straight between the people in an order, on their own card processors: the store holds the customer's card, the driver holds the store's card for their pay, and the store holds the driver's card as collateral. Each charges only what the network's rules say it's owed, and releases the rest. Credits, balances, issuers and cash-outs are gone. Listing a store needs no deposit, and one account can list up to ten stores. An arbiter's award is refunded to the customer's card by the store.",
  },
  {
    version: "1.3",
    date: "2026-10-19",
    summary:
      "Where a network names arbiters, a customer can appeal a store's settlement once, and an arbiter's award is paid from the store's cash-outs. Networks can require drivers to be verified, and can allow age-restricted items, collected in person with ID. Accounts move to new versions of the network with their balance and history.",
  },
  {
    version: "1.2",
    date: "2026-10-10",
    summary:
      "Stores cook once a driver commits. Drivers check in at the store's counter and the store hands the order over by scanning the driver's code. A customer is never charged for food they didn't get unless they chose to: a driver who leaves an order cooking pays for it if no other driver takes it on, and a store that keeps a checked-in driver waiting past its own wait pays their fee, the order goes to another driver, and the customer may cancel for a full refund. Customers can collect a late order themselves and get the store's share of the delivery fee back. Apps can match drivers automatically by a published rule, and drivers can bid automatically.",
  },
  {
    version: "1.1",
    date: "2026-10-09",
    summary:
      "No arbitrators. Handoffs are proved by the giver's code or their own confirmation, at pickup as at the door. Leaving an order at the door is the customer's choice and risk. The store decides a delivery that never arrived (paid either way, by the customer or by the driver's collateral) and has the final say on missing items. Drivers carry a limited number of orders at once, and a priority order goes alone. Limits on waiting orders, one bid per driver, goodie-bag holds, store minimums and busy times.",
  },
  {
    version: "1.0",
    date: "2026-10-09",
    summary: "First published: payments held in escrow, delivery PINs and handover scans, the issue window for missing items, disputes, reputation, privacy and risks.",
  },
];

function sections(t: NetworkTerms): PolicySection[] {
  const reportWindow = spoken(t.report_window_secs);
  return [
    {
      id: "payments",
      title: "Payments and holds",
      summary: "Cards are held at each step and charged only on proof or on the store's decision about the order. HandShake takes no fee.",
      points: [
        "A store can put an item on sale, now, between dates or on days of the week. A sale's price applies when you order while it's running, and it's what any refund and rewards are worked out from. The network checks the dates; the store checks its own weekly times before it accepts.",
        "When you place an order, the store holds your card, on its own card processor, for the food, your share of the delivery fee at most, and your tip. Nothing is charged yet, and the store accepts your order only once the hold is in place.",
        "When a driver commits to an order, before the store starts cooking it, the store holds the driver's card for the value of the food. That's their collateral: it's released once the order is delivered.",
        "When a driver commits, they also hold the store's card for their fee and your tip, so they know they'll be paid before they set off.",
        "Each hold is charged once, after the order is settled, for exactly what the network's rules say its holder is owed, and the rest is released. Nobody can charge a hold twice.",
        "Every hold and charge is a signed record the order's people can check. Yours are on the Transparency page.",
        "A hold lasts about a week on most cards, so an order can be scheduled at most five days ahead, and every order settles within a few days.",
        "There is no platform fee and no operator account. Stores, drivers and customers pay each other directly.",
      ],
    },
    {
      id: "cards",
      title: "Cards and getting paid",
      summary: "Each store and driver is paid into their own Stripe, Square or Clover account. HandShake never holds anyone's money or card details.",
      points: [
        "Stores and drivers connect their own processor account by pasting its keys into HandShake on their own device. The keys stay in that device's keystore and never go on the network.",
        "You type your card only into the processor's own form, in its own frame. HandShake never sees it: the app passes on a single-use token sealed to that store or driver alone.",
        "You can let a store or driver keep your card with their processor, so next time it's one tap and repeat orders can be paid automatically. Only what the network says you owe is ever charged to it, and every charge has a signed record.",
        "Each processor charges the store or driver it pays its usual fee on what's charged. Releasing a hold costs nothing, and customers pay no fees.",
        "Each store sets its own sales tax or VAT, as the seller. Checkout and your receipt show it: added to the price, or already included in it.",
        "Your bank may ask you to confirm a payment is you. The app shows its check, in the processor's own form.",
        "If a card is declined, you can try another on the same order. If a store doesn't hold your card in time, the order lapses and nothing is charged.",
        "A dispute with your bank goes through the processor of whoever charged you, as with any card payment. The order's signed records are the evidence.",
      ],
    },
    {
      id: "handoffs",
      title: "Handing over an order",
      summary: "Every handoff is proved by whoever hands the order over: the store at its counter, the customer at the door.",
      points: [
        `At the store, the driver checks in by scanning the store's ${HANDOFF_CODE_DIGITS}-digit code, or typing it, and the store's app checks it. Checking in shows they're there; it doesn't hand anything over.`,
        "The store hands the order over by scanning the driver's own code, or confirming in its app. Only the store's record of handing it over lets a driver pick it up.",
        `At the door, the customer has their own code. The driver scans it, types the digits read out to them, or the customer confirms in their app. After ${t.max_code_attempts} wrong codes, typing stops working for that order.`,
        "A driver can't pick up an order without the store's record, and can't complete a delivery without the customer's proof.",
        "Share your code only once the order is in your hands: it proves you received it, and can't be taken back.",
        "If you choose to have your order left at the door, you accept that it's delivered once your driver leaves it there. They photograph where; if it's taken after that, it isn't refunded.",
        "Stores can set a limit above which they always hand orders over in person.",
      ],
      effects: [
        { who: "customers", good: "Nobody can mark your order delivered without your code or your say-so, unless you chose to have it left at the door.", bad: "Giving your code before checking your order means accepting it as delivered." },
        { who: "drivers", good: "A delivery completed with the customer's code or confirmation is final: nobody can say later it never arrived.", bad: "Without the customer's proof you can't complete a hand-to-me delivery, and you're paid only once it's complete." },
        { who: "stores", good: "Once you've scanned the driver's code, the food is in their care, covered by their collateral.", bad: "Scan it only as you hand the food over: your record is the proof they have it." },
      ],
    },
    {
      id: "allergies",
      title: "Allergies",
      summary: "A store says what's in its food, and you can tell it about your allergies. Both are between you and it: HandShake carries them, and can't check a kitchen.",
      points: [
        "What a store says about an item or its kitchen is its own word. An item it hasn't said anything about reads as not stated, never as safe.",
        "Your own list is sealed so only your account can read it, and your app compares it with menus on your device. Earlier sealed copies stay on the network when you change it: nobody else can open them, and they can't be erased.",
        "If you tell a store your allergies, they're sealed to that store on your order, and it can keep reading them for as long as it has the order. Your driver can't read them, and nothing on the order names them. Someone watching a store could notice an order waiting for a person.",
        "An order with allergies on it waits for a person at the store, unless the store has chosen to work from its tickets. It can decline if it can't make it as asked, and any hold on your card is released.",
        "A store that can't work to allergy requests says so before you order. Goodie bags may contain any allergen, unless the store says otherwise.",
        "If an item had an allergen the store didn't say it had, report it. Only the store learns it was an allergen; to others it shows as a wrong item. Your order keeps what the store said when you ordered, and the store answers the report like any other. If you're having a reaction, get medical help first, and call emergency services if it's severe. Reporting doesn't affect any other rights you have.",
      ],
      effects: [
        { who: "customers", good: "You see what a store has said before you order, and your allergies stay between you and it.", bad: "No flag doesn't mean safe. For a serious allergy, always ask the store." },
        { who: "stores", good: "You choose how you take requests, and your word is kept as you gave it.", bad: "What you say is yours to keep accurate, under whatever labelling rules apply where you are." },
      ],
    },
    {
      id: "items",
      title: "Missing or wrong items",
      summary: `You have ${reportWindow} after you get your order to report a problem with your items. The store reviews each report and has the final say.`,
      points: [
        "Choose the items and quantities that were missing or wrong, and add a note or photo if you like. The refund for each item is its share of what you actually paid, after any promo.",
        t.appeals
          ? `The store accepts or declines each report. If you disagree with how it settled, you can appeal once, within ${spoken(t.appeal_window_secs)}, to one of the network's arbiters: the order itself picks which, both sides give their evidence to the arbiter alone, and the arbiter can award up to what the store kept. The store refunds an award to your card.`
          : "The store accepts or declines each report, and its answer is final, as it would be if you'd ordered from it directly.",
        `The store's payment for the food waits until your window closes. Reports it accepts, or never answers, are refunded then; however late you report, the store gets at least ${spoken(t.answer_grace_secs)} to answer.`,
        "Your driver's pay doesn't wait for this window: what's inside a sealed bag isn't theirs to answer for.",
        "Your note and photo are sealed to the store. Nobody else can read them.",
      ],
      effects: [
        t.appeals
          ? { who: "customers", good: "A store that ignores your report refunds it, and an arbiter can overrule one that declines unfairly.", bad: "You can appeal an order once, and the arbiter's ruling is final." }
          : { who: "customers", good: "A store that ignores your report refunds it.", bad: "A store can decline a report. Your review is how others find out if it does so unfairly." },
        t.appeals
          ? { who: "stores", good: "You decide every refund first, and you give the arbiter your side of any appeal.", bad: "You refund an arbiter's award to the customer's card." }
          : { who: "stores", good: "You decide every refund. Nobody can grant one over your answer.", bad: "You're paid for the food once the report window closes, not at the door, and reports you don't answer are refunded." },
      ],
    },
    {
      id: "never-arrived",
      title: "If an order never arrives",
      summary: "The driver is accountable for the food from the moment they pick it up until the customer has it.",
      points: [
        "Once your driver has picked up your order, and until it's delivered, you can say it never arrived. Your driver can still turn up and hand it over as usual.",
        `If it still hasn't arrived ${spoken(t.order_lapse_secs)} after pickup, your app says it never arrived for you, so a driver who keeps the food pays for it.`,
        `If nobody says anything, that it arrived or that it didn't, the store settles it as delivered ${spoken(t.order_lapse_secs + t.report_window_secs)} after pickup, so a driver and customer can't keep the food unpaid between them. If yours never came, you can appeal to the network's arbiter.`,
        `If they don't, the store decides. Its app does so on its own once your claim has stood for ${spoken(t.claim_grace_secs)}, or the store can decide sooner.`,
        "When the store decides it never arrived, you get back what you paid for the food, the delivery fee and your tip. The store gets back its share of the fee, and the driver's collateral pays the store for the food.",
        "The store is paid for the food either way, by you if it arrived or by the driver if it didn't, so it has nothing to gain from either answer.",
        "A delivery completed with your code, your confirmation, or left at your door as you chose, can't be claimed afterwards.",
      ],
      effects: [
        { who: "customers", good: "You're never out of pocket for food that didn't reach you.", bad: "If you say it never arrived and it's then delivered, that goes on your record, where drivers see it." },
        { who: "drivers", good: "If you hand it over with the customer's code, nobody can claim it didn't arrive.", bad: "If you pick it up and don't deliver it, you lose your collateral and your fee, and it's on your record." },
        { who: "stores", good: "The food is always paid for, even when nobody says what happened to it.", bad: "You decide what happens when a customer and driver disagree, and that decision is public." },
      ],
    },
    {
      id: "drivers",
      title: "How many orders a driver carries",
      summary: `A driver carries at most ${t.max_concurrent_deliveries} order${t.max_concurrent_deliveries === 1 ? "" : "s"} at once, as on the big delivery apps, and you can ask for one with no others.`,
      points: [
        `A driver can take on at most ${t.max_concurrent_deliveries} order${t.max_concurrent_deliveries === 1 ? "" : "s"} at once. The network counts what they've committed to and refuses one past that, so no app can get around it.`,
        `While delivering, a driver is offered only add-ons on their way: orders from a store they're still to collect from, or going within ${t.add_on_detour_km} km of one of their drop-offs, or the distance they choose.`,
        "Every bid shows how many other orders that driver has, and you choose. A driver can't hide orders they've taken on.",
        "Choose Priority at checkout for a driver with no other orders. Nobody can pick up your order while carrying another, or another while carrying yours. Drivers usually bid more for it.",
        "A driver whose order never arrives is free to take more once their collateral for it is forfeited, which their app does on the store's decision.",
        ...(t.drivers_verified
          ? [`Drivers on this network are verified before they can bid: one of its verifiers checks their identity, licence and insurance, for at most ${t.verification_days} days at a time. A verifier can withdraw a verification, and customers' apps stop accepting that driver at once.`]
          : []),
      ],
      effects: [
        { who: "customers", good: "Your order isn't one of many on a long route, and Priority guarantees it's the only one.", bad: "A Priority order may wait longer for a driver, and usually costs more." },
        { who: "drivers", good: "Add-ons on your way earn more for the same trip.", bad: "Past the limit, or on a Priority order, you're offered nothing more until you deliver." },
      ],
    },
    {
      id: "matching",
      title: "How a driver is chosen",
      summary: "Like the big delivery apps, your app can choose a driver for you, by a rule anyone can check. Or you choose.",
      points: [
        `Drivers bid on your order with their fee and when they'd get it to you. ${spoken(t.bid_window_secs)} after the first bid, your app takes the best one.`,
        `The best bid is the lowest fee once each minute until delivery counts as ${formatCents(t.minute_value_cents)} and the driver's dropped orders count against them, every driver starting as if they'd made ${t.clean_start_deliveries} deliveries without a drop: a faster driver can win at a higher fee, one who drops orders has to bid lower to win, and one early slip doesn't sink a new driver. Your order page shows each bid's working.`,
        "Bids over your fee cap, from a driver who left your order before, or from one who can't take another order right now, aren't chosen. Offers a driver lets lapse count against them like dropped orders.",
        "A driver sees your exact address only once they've committed to your order, with their collateral held.",
        "Choose \"I'll choose\" at checkout to see every bid and accept one yourself.",
        `Once chosen, a driver has ${spoken(t.offer_secs)} to commit, as on DoorDash. Drivers can have their app bid for them at their own rate, skipping stores other drivers report.`,
      ],
      effects: [
        { who: "customers", good: "A driver is found without you watching the screen, by a rule that's the same for everyone.", bad: "The cheapest bid doesn't always win: time and reliability count too." },
        { who: "drivers", good: "Reliable, fast drivers win more often, even at a higher fee.", bad: "Dropped orders cost you bids." },
      ],
    },
    {
      id: "late",
      title: "When a driver or store is late",
      summary: "You're never charged for food you didn't get unless you chose to be. Whoever caused the delay pays for it, as the network can see it.",
      points: [
        "The store starts cooking only once a driver has committed, so an order no driver takes costs nobody anything: cancel it, and you're refunded in full.",
        `A driver who isn't at the store within ${spoken(t.pickup_grace_secs)} of when they're due is moved on by the store's app, and your order goes to another driver.`,
        `A driver can drop an order before picking it up. If the store had started cooking it, they answer for the food: if no other driver takes it on within ${spoken(t.replacement_window_secs)}, the order ends, you're refunded in full, and their collateral pays the store.`,
        `Each store sets how long it may keep a checked-in driver waiting past its ready time (${spoken(t.min_store_wait_secs)} to ${spoken(t.max_store_wait_secs)}; ${spoken(t.store_wait_secs)} if it doesn't), and you see it at checkout. Past that, the driver can call the store late and leave: the store pays their whole fee, your order goes to another driver, and you can cancel for a full refund.`,
        "If your driver is late, or none has your order, you can collect it from the store yourself. The food costs the same, the store's share of the delivery fee comes back to you, and nothing is charged for a driver.",
        `If you choose to collect it and don't come within ${spoken(t.collection_window_secs)} of when it's due ready, the store keeps the price of the food it made. If you cancel while a driver is on the way and nobody's late, you pay for the food and the driver's fee, as on any app.`,
        `If nobody comes to the door, your driver records arriving (your app tells you) and waits ${spoken(t.dropoff_wait_secs)}. Then they can say you weren't there: it's paid as delivered once your report window has passed, and counts against you. If you were there, say so before then: the store decides, and if it sides with you, you're not charged and the driver answers for the food. Until it's decided, you can still take it from your driver.`,
        `A pickup you don't collect within ${spoken(t.collection_window_secs)} of its being ready lets the store keep the price of the food it made, and counts against you. If the store can't give you your order, tell it: it decides, and either cancels with no charge or says the order is ready, which gives you the same time again to collect it. You can report this once per order, and the store made your food: not being able to get there is still yours to pay for. If a store accepts a pickup and then goes silent on it for ${spoken(t.order_lapse_secs)} (counted from when it's due ready, while it's still being made), you can close it with no charge.`,
        "A scheduled order is sent to its store at its time, by your app. If the store is closed then, or your device was offline for more than half an hour past it, it's cancelled instead and nobody pays anything.",
        "Every deadline that costs someone else if it's claimed early (a driver leaving, a store moving a driver on, calling a store late, ending an order no driver came for, keeping the food of a customer who never came, a driver saying nobody came to the door) is proved against a public time source run by independent organisations, so nobody can claim one early.",
        `An order can change drivers at most ${t.max_driver_changes} times. After that you can collect it or cancel it.`,
        "While a driver who left your order cooking answers for it, you can't cancel it: wait for another driver (you're refunded in full if none comes in time) or collect it yourself.",
        `If it's the store's turn on your delivery (confirming your driver, checking them in, handing it over, or ending it after a driver left) and nobody moves it on for ${spoken(t.order_lapse_secs)}, counted from when it's due ready if that's later, you can close it with no charge. The store pays any driver it had checked in, and it counts against the store.`,
      ],
      effects: [
        { who: "customers", good: "No driver, a no-show, or a slow store never costs you anything.", bad: "If you choose to collect and don't, aren't there for your delivery or pickup, or cancel while it's on its way, you pay for the food." },
        { who: "drivers", good: "Checked in, you're paid in full if the store keeps you waiting, and it never counts against you. Nobody at the door? After the wait, you're paid as delivered unless the store sides with the customer.", bad: "Leaving an order the store has cooked can cost you its price, if no one else takes it on." },
        { who: "stores", good: "You only cook for a committed driver, you set how long a driver waits, and you're paid for food a driver leaves behind.", bad: "Keep a checked-in driver waiting past your wait and you pay their fee, and the customer may cancel for a full refund." },
      ],
    },
    {
      id: "fair-use",
      title: "Keeping it fair",
      summary: "Limits that keep any one person from crowding out everyone else, enforced by the network.",
      points: [
        `A customer can have at most ${t.max_pending_orders} order${t.max_pending_orders === 1 ? "" : "s"} placed within ${spoken(t.store_response_secs)}, the time a store has to answer. An order costs nothing until a store accepts it, so this stops anyone burying a store in orders.`,
        "A driver bids on an order once. Their offer is their offer, so no one can fill an order's bids with their own.",
        "When a store confirms your goodie bag, it's held for you for the time the store set. If you haven't ordered it by then, it goes back on sale. Your app orders it the moment it's confirmed.",
        "A store can set a minimum order, and say it's busy, adding to its usual prep time. You see both before you order.",
        `One account can list at most ${MAX_STORES_PER_OWNER} stores, and a store takes orders only once its processor account is connected, so the stores you can find are real businesses.`,
        "You claim a goodie bag once, review an order's store and driver once each, and report each item on an order once.",
        t.restricted_min_age
          ? `Age-restricted items, such as alcohol, are sold only to people ${t.restricted_min_age} or older, collected in person: you confirm your age when ordering, and the store checks your ID at the counter. They're never delivered.`
          : "This network doesn't sell age-restricted items, such as alcohol.",
      ],
    },
    {
      id: "cancellations",
      title: "Cancellations",
      summary: "What a cancellation costs depends on how far the order had got.",
      points: [
        "Before a store accepts your order, cancelling costs nothing.",
        "After the store accepts, cancelling means the store keeps the price of the food it started on. After a driver is assigned, the driver keeps their fee as well. Your tip always comes back to you.",
        "If a store or driver cancels, everything they'd have been paid is returned to you.",
        "Once the driver has picked up your order, it can't be cancelled: it's either delivered, or it never arrives (see above).",
        "Once a store has handed an order over, to its driver or to you, it can't cancel it, and a driver who's taken it from the store can't drop it. If the driver's app never records the pickup, the store records it.",
      ],
    },
    {
      id: "who-decides",
      title: "Who decides",
      summary: t.appeals
        ? "There's no company or operator. Proof settles almost everything; where it can't, the store decides, and a customer can appeal its settlement to one of the network's arbiters."
        : "There's no company, operator or referee. Proof settles almost everything; where it can't, the store decides, within rules everyone's app enforces.",
      points: [
        "A handoff code, a confirmation, or a cancellation settles an order on its own.",
        "For each order, the store writes one outcome and one settlement of the food, and the network accepts no second of either. Every payment rests on them, so no two payments can contradict each other.",
        "The store can't take both the customer's money and the driver's collateral, can't refund more than the reports it cites are worth, and can't decide an order it cancelled went undelivered.",
        "Every decision is signed and public, and recorded against whoever it went against.",
        ...(t.appeals ? ["An arbiter rules on an appeal once, awarding no more than was asked. The store's app refunds the award to the customer's card. The ruling is public, so a customer whose award isn't refunded has it as evidence for a dispute with their bank."] : []),
      ],
    },
    {
      id: "reputation",
      title: "Reputation over time",
      summary: "Your history follows you, and it's built only from things that actually happened.",
      points: [
        "Ratings are one vote per customer per order, and only from that order's customer.",
        "Completed orders are recorded for the store and driver. A store's decision that an order never arrived is recorded against the driver; that a claimed order had arrived, against the customer.",
        "Nobody can edit or delete reviews, ratings or history, including their own.",
        `Ratings and records count the last ${t.reputation_window_days} days, so they say how someone is doing now. Older history stays on the network.`,
        "Drivers see a customer's history before they bid.",
      ],
      effects: [
        { who: "customers", good: "A clean history means drivers are glad to take your orders.", bad: "Saying an order never arrived when it had stays on your record." },
        { who: "stores", good: "Completed orders and good ratings build the rating customers see.", bad: "Ratings can't be removed, even unfair ones." },
        { who: "drivers", good: "Completed deliveries build the record customers see when choosing a bid.", bad: "Orders that never arrived stay on your record." },
      ],
    },
    {
      id: "account",
      title: "Your account and getting it back",
      summary: "Your account is a key on your device. There's no company that can reset it, so these are the ways back in.",
      points: [
        "Moving to a new phone: your old phone hands the account to the new one, with your ratings and history. Your old phone can't act for you after that.",
        "Losing your phone: your recovery phrase (twelve words you write down) or enough of your guardians (people you choose, who vouch for your new phone) bring your account back.",
        "After a recovery, a store or driver connects their processor account again on the new phone: its keys never leave the device they were pasted into. Holds and charges already made stand.",
        "Anyone with your recovery phrase can take over your account. Keep it on paper, never share it, and no one from HandShake will ever ask for it.",
        "Guardians can't touch your account on their own: only enough of them together, for a phone you're recovering onto. Your plan publishes their keys, never their names.",
        "When the network moves to a new version, you move your account to it from the old app: your details, stores and ratings come with you. The old version stops working for your account once you move.",
      ],
    },
    {
      id: "privacy",
      title: "Privacy",
      summary: "You're known by a key, not a name. What's private is sealed; what isn't is said here.",
      points: [
        "Customers publish no name. Your name and exact address are sealed to the store and to the driver you accept, for that order only.",
        "Handoff photos and locations are sealed between the two people at the handoff.",
        "Drivers publish no location. They find work by reading the open orders around them.",
        "Visible to anyone: which customer key ordered from which store, an order's prices, and its drop-off area to within about a kilometre.",
      ],
    },
  ];
}

/// What could go wrong, plainly.
function risks(t: NetworkTerms): string[] {
  return [
    "HandShake is software run by its users, not a company that stands behind your orders. No one can reverse a payment the network has settled, and there's no customer service desk.",
    "When a customer and driver disagree about a delivery, the store decides. A store could side with a customer against a driver who did deliver; it gains nothing by it, and its decision is public, but the network can't overturn it. Drivers are protected by handing over against the customer's code.",
    "An order left at the door is delivered once it's left. If it's taken after that, the customer bears the loss, as with a parcel left without a signature.",
    "Nothing forces a store to answer a report about missing items before it settles the order; a store that settles early, or declines unfairly, answers to its reviews.",
    `A store could refuse to check a driver in, then collect that driver's collateral if they leave and no one else comes. The network can't tell a store that won't check drivers in from a driver who never arrived, so it sides with the store, the party with the most to lose. Drivers can report it; reports from drivers who've delivered for at least ${t.min_reporter_stores} different stores show on the store's record, and drivers' apps can skip reported stores.`,
    "Payments are made on each store's and driver's own processor account, under its terms. A store or driver could charge a held card more than the network says they're owed; every rightful charge has a signed record, so anything beyond it is a clear case for a dispute with your bank.",
    "If you lose your phone with no recovery phrase or guardians set up, your account can't be recovered by anyone. A phone found by someone else can still act as you until you recover the account.",
    "Everything you publish is permanent and copied across the network. Reviews, ratings and order records can't be deleted.",
    "Which store a customer key ordered from, and roughly where, is public. Using one identity for everything links those orders together.",
    "Reviews can't detect a store buying from itself under another identity to rate itself.",
    "Some deadlines (store response times, report windows, scheduled orders, promo expiry) rely on clocks people control, and a store's own times are taken at its word. The rules above bound the damage but can't remove it entirely. Calling a store late, and a driver leaving, are proved against the public time source.",
    "The software is provided as is, without warranty. Check your order before confirming it, and keep your device and identity secure.",
  ];
}

export const en: PolicyContent = { changes, sections, risks };
