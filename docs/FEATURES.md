# Features

Everything HandShake does, by who uses it. Each feature links to the doc that explains it, where there is one. How it all works underneath is in the [README](../README.md) and [SECURITY.md](SECURITY.md).

**Contents:** [Customers](#customers) · [Stores](#stores) · [Drivers](#drivers) · [Payments](#payments) · [Accounts and privacy](#accounts-and-privacy) · [Fairness and safety](#fairness-and-safety) · [Network roles](#network-roles) · [Everywhere in the app](#everywhere-in-the-app)

## Customers

**Finding food**
- Browse the stores near you, with search, sorting and filters (cuisine, dietary needs, rating, delivery time, open now, deals) that say what they leave out.
- *Order again*: the stores you last ordered from, on the home screen.
- A store's page: its menu by category, photos and descriptions, ratings and reviews, hours, address and contact, and how busy it is.
- Allergies and intolerances: tell the app yours once, and every menu flags what may affect you ([ALLERGENS.md](ALLERGENS.md)).

**Ordering**
- A cart for each store, kept as you left it.
- Menu choices: sizes, add-ons, nested options, required and free picks, priced as you choose ([MENU_CUSTOMIZATION.md](MENU_CUSTOMIZATION.md)).
- Delivery or pickup, for now or scheduled for later, and recurring orders that remind you to confirm each one.
- The cart is checked against the store as it is now: a new price shown beside the old one, an item that's gone or sold out marked to remove, choices that no longer fit chosen again. Nothing is ordered until each is dealt with.
- Notes for the store and for the driver, and how you'd like it handed over: to you, outside, or left at the door.
- Choose your driver from their bids, or let the app pick by a published rule. Set the most you'll pay for delivery, and tip.

**Deals and rewards**
- Promo codes and deals that apply themselves, some for delivery or pickup only, with a switch to the way a deal needs.
- Free delivery, or part of it, on bigger orders where a store offers it, with how much more reaches it shown in your cart.
- Goodie bags: a store's surplus at a discount, for a pickup window.
- Sale prices, crossed out beside the full price.
- Each store's rewards program: points on every order, tiers, birthday gifts, and rewards to redeem in your cart ([REWARDS.md](REWARDS.md)).

**After ordering**
- Follow your order step by step, with the driver's first name, photo and car on a map that follows the roads, and chat with them.
- Hand-off codes that prove your order reached you.
- Report missing or wrong items, or a poor delivery: the store refunds all, part or none, and may add points as an apology, shown on your order.
- Appeal a store's decision to the network's arbiters.
- Receipts you can print, ratings and reviews, and *Reorder* from any finished order.

## Stores

**Setting up**
- Open one or several stores, each with its own details, photos, hours, time zone, delivery area and contact.
- Sales tax: your own rates by category, added at checkout or included in prices ([SALES_TAX.md](SALES_TAX.md)).
- Allergy policy: whether you take customers' allergies, and what you tell them.

**The menu**
- Items with photos, descriptions, dietary tags, allergen facts and tax categories.
- Choice groups shared across items, with nested options and their own prices.
- Mark an item sold out, put it on sale (now or on a weekly schedule), or take it off the menu.
- Goodie bags: list surplus food for a pickup window, and end a listing early.

**Orders**
- Accept or decline each order, or accept them automatically; say how long it'll take, or that you're busy.
- Check drivers in and hand orders over with a scan.
- Issues: customers' reports and pickup problems in one place, each answered with a refund of all, part or none.

**Growing**
- Promo codes: percent or amount off, free items, buy-one-get-one, minimum spends, loyalty counts, new customers only, limits per customer or in all, end dates, and delivery or pickup only.
- Delivery cost sharing: cover part of each delivery fee, and more on bigger orders, up to free delivery.
- A rewards program of your own: points, tiers, bonuses on items and happy hours, birthday gifts, and points given as a thank-you or apology.
- Insights on how the week or month went, reviews to read, and a tax report of what you sold ([TAX_REPORTING.md](TAX_REPORTING.md)).

**Customers**
- Each customer's history with you and their report pattern; rate them, and block those you won't serve.

## Drivers

- Go online to see orders near you, or near the store you're collecting from, wherever you are in the app.
- Set your own delivery fee: a rate per mile or km, or up to ten distance bands.
- Bid on orders with a fee and an arrival time; take more than one on the way.
- Check in at the store with its code, collect with yours, and prove each hand-off with the customer's code. A store that keeps you waiting past the network's limit pays your fee.
- Earnings by week and month: deliveries, fees, tips, and what stores paid for keeping you waiting, with a CSV for your records.
- Verification by the network's verifiers, a photo and vehicle customers see, and a record of your customers.

## Payments

- Card payments straight between the people in an order, on each store's and driver's own Stripe account, with Square to come. No platform fee, ever ([DIRECT_PAYMENTS.md](DIRECT_PAYMENTS.md)).
- Every payment is held first and charged only what the order's outcome says, once, whatever fails along the way.
- Cards can be kept with a store or driver you use often.
- A payments screen of everything you paid and were paid, beside your card statement.

## Accounts and privacy

- No password and no company account: your key lives on your device.
- Move to a new phone with the same account, or recover a lost one through guardians you choose or a twelve-word phrase ([RECOVERY.md](RECOVERY.md)).
- Your exact address is sealed to you and your driver; the store sees your name and notes, and nobody else does ([SECURITY.md](SECURITY.md)).
- Live location and chat go app to app and are never stored.

## Fairness and safety

- Ratings that count only established raters, within days of an order, and never on an order that was reported ([REPUTATION.md](REPUTATION.md)).
- Your own record, as stores and drivers see it.
- Blocks in every direction, between customers, stores and drivers.
- Limits that stop spam and abuse: on orders, reports, codes and sign-ups.

## Network roles

- **Arbiters** rule on appeals of a store's decision, with both sides' evidence sealed to them.
- **Verifiers** check drivers' documents and vouch for them.
- **Whoever runs a network** sets its currency, rules and services, and runs its small helper servers ([DEPLOYMENT.md](DEPLOYMENT.md), [OPERATIONS.md](OPERATIONS.md)).

## Everywhere in the app

- English and Spanish, including every refusal from the network ([I18N.md](I18N.md)).
- Light, dark, or your device's theme; high-contrast and large-text friendly; less motion when your device asks for it.
- Notifications that wake a closed app for new orders and updates, without the relay learning anything about them.
- A desktop app for macOS, Windows and Linux; phones are planned ([MOBILE.md](MOBILE.md)).
