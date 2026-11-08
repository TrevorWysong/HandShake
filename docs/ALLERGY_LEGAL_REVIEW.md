# Allergy wording: first-pass legal review

Reviewed 2026-11-06 for the project's owner. **This isn't legal advice and no lawyer has reviewed it.** It's meant to shrink what counsel has to look at: what the rules seem to require, what changed because of them, and what only counsel can answer. Laws here are moving fast, and some sources below are secondary.

## What the rules seem to say

| Where | Rule | What it means here | Source |
|---|---|---|---|
| US, federal | Nine major allergens, sesame since 2023. Labelling rules (FALCPA) don't reach food packed to order at the point of purchase. | The list covers all nine. A restaurant's made-to-order food is mostly outside federal labelling. | [FDA](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies), [Q&A edition 5](https://www.fda.gov/media/117410/download) |
| US, model code | The 2022 Food Code asks for written notice of major allergens in unpackaged food, electronic means included. States adopt it, or don't, on their own terms. | Item statements are such a notice, where a store fills them in. | [FDA](https://www.fda.gov/food/fda-food-code/summary-changes-2022-fda-food-code) |
| US, "may contain" | Must be truthful and not misleading, is no substitute for good practice, and isn't for something that's an ingredient. | Validation refuses an allergen as both "contains" and "may contain". | [FDA Q&A](https://www.fda.gov/media/117410/download) |
| US, "gluten-free" | Under 20 ppm on packaged food; FDA recommends restaurants' menu claims match. | Tags are free text. A claim the item's own statement contradicts is hidden. | [FDA](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/questions-and-answers-gluten-free-food-labeling-final-rule) |
| New York | Online menus need a notice and either a way to state an allergy or intolerance, or allergen information per item. Up to $125 per violation. | Checkout's section and the menu notice aim at this. A `NotAccepted` store needs item statements instead. | [PBH §1356](https://www.nysenate.gov/legislation/laws/PBH/1356) |
| California | SB 68: chains of 20+ locations disclose the nine allergens across menus and online ordering from July 2026. **Secondary source: the statute's site refused the request.** | A covered chain can't leave items "not stated". | [Summary](https://foodlabelmaker.com/blog/labeling-regulations/california-sb68-restaurant-allergen-disclosure-law/) |
| Massachusetts, Rhode Island | Menu notice asking customers to tell staff. **Secondary source.** | The menu notice is close, not verbatim. | [FARE](https://www.foodallergy.org/our-initiatives/advocacy/know-your-rights/food-allergies-and-food-service-establishments) |
| UK | Allergen information for distance selling is required before purchase and at delivery, for 14 allergens. | Stores there can't leave items "not stated". | [FSA](https://www.food.gov.uk/business-guidance/allergen-guidance-for-food-businesses) |
| EU | Regulation 1169/2011: the same two moments, on the food business operator. The page names no platform duty. | As the UK. | [Commission](https://food.ec.europa.eu/food-safety/labelling-and-nutrition/food-information-consumers-legislation/distance-selling_en) |
| Washington State | My Health My Data: no revenue threshold, separate consent to collect and to share health data, a standalone policy, a right to delete, private suits. Whether allergies are covered, and whether "necessary to provide the service" fits, is counsel's. **Secondary sources.** | See the questions below. | [Clark Hill](https://www.clarkhill.com/news-events/news/its-here-the-who-what-and-how-of-washingtons-new-my-health-my-data-act-and-its-private-right-of-action/) |
| EU, UK privacy | Health data is special category data under GDPR Article 9, generally needing explicit consent. | See the questions below. | [ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/a-guide-to-lawful-basis/special-category-data/) |

## Changed because of this review

**Safety.**
- "Shellfish" meant crustaceans only, so someone allergic to clams who picked it wouldn't have been warned about molluscs. Spanish "Mariscos" had the same flaw. Both are named now, with examples.
- Spanish names include regional alternatives (maní, soya, lupino).
- "Gluten" says which cereals.
- A "free from" tag is now contradicted by "may contain" too.

**Claims that said too much.**
- "Has none of the common allergens" is now "lists none ... that isn't a promise it's free of them".
- "Can be left out" now says it may still meet it in the kitchen.
- "Nobody else can read them", "nothing public shows you sent any" and "can't hint" were absolutes the design doesn't fully meet. They now state the limits, including timing and that a store keeps what it was told.
- "You weren't charged" is now "any hold on your card is released".

**Disclosure.**
- Sealed copies can't be erased, which was unstated; it's stated now.
- Saving a list says what happens to it, by way of consent.
- The medical line now names emergency services. "Between you and it", which read like giving up rights, is now "doesn't affect any other rights you have".
- Stores are told they're responsible, and that rules differ.
- Menus carry an allergy and intolerance notice, and hiding items says what's left isn't promised safe.

## Questions only counsel can answer

1. **Who's responsible?** The app says there's "no company or operator". Whoever publishes the app, chooses its defaults and runs a network's release may still be a publisher, operator or controller. Does that claim hold, and does it mislead?
2. **Does warning create a duty?** Matching and flagging are the app's own output, not just a store's words. Could doing it invite a claim for negligent undertaking or product liability when a match misses? Are the disclaimers enough, and does Section 230 reach any of it?
3. **Health data consent.** Is a list saved after a clear notice, then sent by default at checkout with an off switch, enough for Article 9 and My Health My Data's separate consents? Or does sharing need its own opt-in? That would add friction you've asked to avoid. Is a standalone health privacy policy needed?
4. **Erasure.** Sealed copies and orders can't be erased from the network by design, though only their holders can open them. Is that compatible with deletion rights? Would destroying a key count as erasure?
5. **Warranty language.** "As is, without warranty" appears in the policies. Is it enforceable for food-safety information, and are there terms anyone actually accepts?
6. **Stores' accuracy.** Is telling stores they're responsible enough, or should they accept terms before stating allergens?
7. **Licenses.** HandShake is under PolyForm Shield (`LICENSE`), but the zomes compile in Holochain's HDK and HDI, which are CAL-1.0, and their source files don't appear to carry CAL's "Combined Work Exception". Holochain says apps needn't be open source. Does that hold for the compiled zomes, or must they be offered under CAL? `NOTICE.md` gives way to CAL where it applies. Worth asking the Holochain team too.
8. **Terms of use.** `web/src/lib/policies/terms.ts` is placeholder text with bracketed blanks. Acceptance is a checkbox recorded on the device, and asked again when `TERMS_VERSION` changes. Is that enough evidence of agreement, or should it be recorded per account? Should stores and drivers accept separate terms? No network with live payments can be packaged until `TERMS_DRAFT` is cleared.
9. **Exact notices.** Should Massachusetts, Rhode Island and New York wording be verbatim?

## A decision for the owner

**Require statements where the law does.** "Not stated" suits a US independent, but not a UK or EU store, or a large California chain. A network setting could make validation refuse a menu item with no statement. It's a change to the network rules, so it's cheapest before launch. Recommended once you know where the first network will run.

## The wording

Every string is under `allergy.`, `allergen.`, `myAllergies.`, `cart.allergy.`, `allergyPolicy.`, `menuEditor.allergens`, `storeInfo.allerg`, `store.allergyNotice`, `store.hiddenNote`, `issues.allergen`, `decline.*.CantMakeAsAsked` and `restore.allergiesAgain` in `web/src/i18n/{en,es}.ts`, and in the "Allergies" section of `web/src/lib/policies/{en,es}.ts`. The design is in [ALLERGENS.md](ALLERGENS.md).
