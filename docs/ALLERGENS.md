# Allergens

How a store says what's in its food, how a customer tells a store about their allergies, and what the network can and can't promise about either.

## What a store says

- **Per item:** `MenuItem.allergens`, an `AllergenFacts`: what's in it (`contains`), what it may meet (`may_contain`), what the kitchen can leave out if asked (`can_omit`), anything beyond the fixed list in the store's own words (`other`), and a `note`. `None` means the store hasn't said, and every screen reads that as "not stated", never as safe.
- **Per choice:** `ModifierOption.contains` and `other_allergens`, because an item's statement can't speak for "add cheese".
- **Per store:** `MerchantCatalog.allergy_policy`: what's handled in the kitchen, whether it takes requests (`Welcome`, `BestEffort`, `NotAccepted`), whether auto-accept may take orders with allergies (`auto_accept_requests`), and a note. What's listed for the kitchen shows as a possible allergen on the whole menu for anyone it concerns.

The list is 15 codes, the US and EU required lists together, with wheat and gluten apart, so every store's word means the same, translates, and can be matched. The network checks a code's shape, not the list: the list lives in the app (`lib/storefront/allergens.ts`), so adding one a new region names is an app update, not a new network, and an app that doesn't know a code yet shows it as written. A store's own words cover anything else, and are bounded, shown as written, and matched only exactly.

Validation checks shape only: an allergen listed once, not both in an item and possibly in it, bounded words. It can't check a kitchen, so the app always presents this as the store's own word.

An order line's `priced_version` pins the exact item version bought, so `get_order_lines` still shows what was said when it was ordered, whatever the store says later.

A goodie bag says what it can (`GoodieBag.allergens`), and otherwise reads "may include any allergen". A dietary tag its own item's statement contradicts ("Vegan" beside milk) is hidden from customers, and the store's told why in its editor.

## What a customer tells a store

- **Their list:** a `SealedAllergies` entry, sealed to them and padded to one size. Every account writes one with its profile, so holding one says nothing. A network migration carries it in the parcel. A recovered account starts empty, as its old key is gone, and is told to add them again. It's sealed rather than private because private entries don't survive a device move (HOLOCHAIN_ISSUES.md, issue 10), and losing someone's allergies silently would be the dangerous way to fail.
- **Matching:** on their device (`lib/storefront/allergens.ts`), so the network never learns what they looked for.
- **On an order:** inside `kitchen_note`, sealed to the store. There's no public field for it, and every order carries a padded box, so neither a box's presence nor its length hints at an allergy. A driver can't read it.
- **Who answers:** unless a store's chosen to work from its tickets, its auto-accept leaves an order with allergies for a person. Nobody having come, its conductor declines the order before its window closes: left to lapse, anyone could mark an unattended store as never answering by ordering with a note it won't accept. A store that says `NotAccepted` refuses the order before it's placed, and a modified app can't get past a store still reading it and declining.
- **Declining says nothing of allergies:** a decline's reason is public, so it's `CantMakeAsAsked`, which a note could equally cause.

## Disputes

A report that an item had an allergen the store didn't list is public only as a wrong item, with `IssueEvidence.allergen` sealed to the store: an allergy is the customer's to keep. It goes through the same reports, refunds and appeals. The report screen tells a person to get medical help first, because a refund can't answer a reaction.

## Limits worth saying plainly

- An order at an auto-accepting store that waits while others are accepted at once could hint that it has allergies on it, to someone watching that store's orders. A store that lets auto-accept take them closes this.
- Saving a changed list writes an update, so someone watching an account can see it changed something, though never what.

- A store can be wrong, or lie. The record shows what it said.
- No flag doesn't mean safe.
- Wording here isn't legal advice, and labelling rules differ by place. See [ALLERGY_LEGAL_REVIEW.md](ALLERGY_LEGAL_REVIEW.md) for what a first-pass review found and what counsel still needs to answer.
