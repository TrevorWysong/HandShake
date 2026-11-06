// Checkout: what's in the bag, how it's to be fulfilled, its one discount,
// what it comes to, and placing it -- the card it's paid with going to the
// store with it.
// Its parts live beside it: the delivery choices (`useDeliveryOptions`,
// DeliverySections), the discount (`useDiscounts`, DiscountSections), the
// money (`pricing`, CartTotals) and the bar that places it (CheckoutBar).
// What's sent is checked again by the network: totals, discount, range,
// hours, and what the store may hold on the card.
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { CheckoutDraft } from "../../../lib/orders/recurring";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Button, Checkbox, Notice } from "../../../components/ui";
import { PaySheet } from "../../../components/payments/PaySheet";
import { ItemSheet } from "../../../components/store/ItemSheet";
import { cartItems, menuLines, useCart } from "../../../store/cart";
import { useSession } from "../../../store/session";
import { useCustomerSettings } from "../../../store/roleSettings";
import { useTerms } from "../../../store/network";
import { createRecurringTemplate, requestDelivery, requestPickupOrder } from "../../../holochain/zomes/dispatch";
import { paymentProfileOf } from "../../../holochain/zomes/payments";
import { actionHash, bytesEqual, bytesToHex } from "../../../holochain/decode";
import type { DropoffPreference, PaymentInput, RecurrenceRule } from "../../../holochain/types";
import { earnedFor, pointsEarned } from "../../../lib/rewards/rewards";
import { storeStatus } from "../../../lib/storefront/storeHours";
import { wakeTokensForOrder } from "../../../lib/network/push";
import { useAction } from "../../../lib/hooks/useAction";
import { useClock } from "../../../lib/hooks/useClock";
import { useResource } from "../../../lib/hooks/useResource";
import { formatCents } from "../../../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../../../lib/ui/motion";
import { useT } from "../../../i18n";
import { AmountChoice, NoteSection, Section, ToggleChip } from "./CartPieces";
import { BagNotices } from "./BagNotices";
import { bagProblems } from "../../../lib/storefront/bags";
import { CartLines, type LineEdit } from "./CartLines";
import { CartTotals } from "./CartTotals";
import { CheckoutBar } from "./CheckoutBar";
import { AllergySection } from "./AllergySection";
import { useCartAllergies } from "./useCartAllergies";
import { useMyAllergies } from "../../../lib/hooks/useMyAllergies";
import { hasAllergies, NO_ALLERGIES } from "../../../lib/storefront/allergens";
import type { AllergySet } from "../../../holochain/types";
import { DeliverToSection, MatchingSection, RepeatSection, SpeedSection, WhenSection } from "./DeliverySections";
import { PromoSection, RewardsSection } from "./DiscountSections";
import { fetchCartStoreInfo, NO_ITEMS } from "./checkout";
import { TIP_PRESETS_PERCENT } from "./options";
import { feeCapCents, priceCheckout, scheduledTime, tipCents as tipFor } from "./pricing";
import { useDeliveryOptions } from "./useDeliveryOptions";
import { useDiscounts } from "./useDiscounts";

export function Cart() {
  const t = useT();
  const cart = useCart();
  const navigate = useNavigate();
  const terms = useTerms();
  const now = useClock();
  const agentPubKey = useSession((s) => s.agentPubKey);
  const setSessionLocation = useSession((s) => s.setLocation);
  // Placing the order, or saving it to repeat -- one at a time.
  const action = useAction();

  const catalogRef = cart.catalogRef;
  const { data: storeInfo } = useResource(catalogRef && `cart-store:${bytesToHex(catalogRef)}`, () => fetchCartStoreInfo(catalogRef!));
  // How the store is paid: its processor's card form. A store ordering from
  // itself pays itself nothing.
  const merchant = cart.merchant;
  const { data: storeProfile } = useResource(merchant && `payment-profile:${bytesToHex(merchant)}`, () => paymentProfileOf(merchant!));
  const ownStore = !!agentPubKey && !!merchant && bytesEqual(agentPubKey, merchant);
  // A card this account saved with the store, offered in one tap -- keyed by
  // the account, so nobody else signed in here is ever offered it.

  // A recurring order brought here to confirm starts as it was set up.
  const draft = (useLocation().state as { recurring?: CheckoutDraft } | null)?.recurring;
  const options = useDeliveryOptions(draft);
  const discounts = useDiscounts(storeInfo, now);
  // Pickup orders skip the whole driver half of this screen: there's no
  // driver in that vertical at all.
  const [chosenFulfillment, setFulfillment] = useState<"Delivery" | "Pickup">("Delivery");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  // Two notes, each readable only by who it's for: the store (sealed to
  // it) and, for a delivery, the driver (sealed with the address).
  const [kitchenNotes, setKitchenNotes] = useState(draft?.kitchenNotes ?? "");
  // Their allergies go to the store unless they say otherwise -- and, for an
  // order for someone else, as changed for this order alone.
  const { mine } = useMyAllergies();
  const [tellChoice, setTellChoice] = useState<boolean | null>(null);
  const [changedAllergies, setChangedAllergies] = useState<AllergySet | null>(null);
  const tellingStore = tellChoice ?? hasAllergies(mine);
  const allergies = changedAllergies ?? mine;
  const [dropoffNotes, setDropoffNotes] = useState(draft?.dropoffNotes ?? "");
  const [editing, setEditing] = useState<LineEdit | null>(null);
  /// Choosing the card it's paid with.
  const [paying, setPaying] = useState(false);

  const menuItems = storeInfo?.menuItems ?? NO_ITEMS;
  const allergyPolicy = storeInfo?.allergyPolicy ?? null;
  const allergiesRefused = tellingStore && hasAllergies(allergies) && allergyPolicy?.requests === "NotAccepted";
  const allergyMatches = useCartAllergies(catalogRef, cart.lines, menuItems, allergyPolicy, tellingStore ? allergies : mine);
  const itemOf = (itemRef: Uint8Array) => menuItems.find((row) => bytesEqual(row.hash, itemRef))?.item;
  // Age-restricted items (alcohol, tobacco) are collected in person, where
  // the store checks ID -- the network's rule.
  const ageRestricted = cart.lines.some((line) => itemOf(line.itemRef)?.age_restricted);
  const fulfillment = ageRestricted ? "Pickup" : chosenFulfillment;
  const delivery = fulfillment === "Delivery";
  // Goodie bags run on their own windows: no store hours, no minimum, no
  // promo, and nothing scheduled for later.
  const menu = menuLines(cart.lines);
  const hasBags = menu.length < cart.lines.length;
  const bagIssues = bagProblems(cart.lines, delivery, now.getTime() * 1000);

  const subtotalCents = cart.total();
  const tipCents = tipFor(subtotalCents, options.tipPercent, options.customTip);
  const maxFeeCents = feeCapCents(options.feePreset, options.customFee);
  // The store's most a delivery fee may be: a cap above it is refused.
  const feeLimitCents = storeInfo?.maxDeliveryFeeCents ?? null;
  const overFeeLimit = feeLimitCents !== null && maxFeeCents > feeLimitCents;
  const taxIncluded = storeInfo?.pricesIncludeTax ?? false;
  const taxRates = storeInfo?.taxRates ?? [];
  const price = priceCheckout({
    fulfillment,
    subtotalCents,
    discountCents: discounts.discountCents,
    lines: cart.lines.map((line) => ({ taxCategory: itemOf(line.itemRef)?.tax_category ?? "", totalCents: line.priceCents * line.quantity })),
    taxRates,
    taxIncluded,
    tipCents,
    maxFeeCents,
    subsidyPercent: storeInfo?.subsidyPercent ?? 0,
    minOrderCents: storeInfo?.minOrderCents ?? null,
    menuSubtotalCents: menu.reduce((sum, line) => sum + line.priceCents * line.quantity, 0),
    leaveAtDoorMaxCents: storeInfo?.leaveAtDoorMaxCents ?? null,
  });
  // The store's tip limit (`MerchantCatalog::max_tip`): a tip passes
  // through its card to the driver.
  const tipLimit = storeInfo?.tipLimit ?? null;
  const tipLimitCents = tipLimit && Math.max(Math.floor((price.orderTotalCents * tipLimit.percent) / 100), tipLimit.floorCents);
  const overTipLimit = tipLimitCents !== null && tipCents > tipLimitCents;
  // The door only where the store allows it for an order this size.
  const dropoffPreference: DropoffPreference = options.chosenPreference === "LeaveAtDoor" && !price.doorAllowed ? "HandToMe" : options.chosenPreference;
  // What it earns, as the program counts it once the store settles: the
  // food paid, without tax.
  const program = discounts.rewardsProgram;
  const pointsPreview = program
    ? earnedFor(program, discounts.rewardsCard?.state ?? null, pointsEarned(program, cart.lines.map((l) => ({ itemRef: l.itemRef, totalCents: l.priceCents * l.quantity })), price.discountedSubtotalCents - (taxIncluded ? price.taxCents : 0), now.getTime() * 1000))
    : 0;

  if (cart.lines.length === 0) {
    return (
      <div className="px-6 py-20 text-center">
        <p className="text-sm text-ink-400">{t("cart.empty")}</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate("/customer")}>
          {t("cart.browse")}
        </Button>
      </div>
    );
  }

  const requestedDeliveryTime = hasBags ? null : scheduledTime(options.scheduled, options.scheduledFor);
  const scheduleInvalid = !hasBags && options.scheduled && (!options.scheduledFor || (requestedDeliveryTime !== null && requestedDeliveryTime <= now.getTime() * 1000));
  // Open when the order's for: now, or a scheduled delivery's time.
  const orderFor = delivery && requestedDeliveryTime !== null ? new Date(requestedDeliveryTime / 1000) : now;
  const storeHours = storeInfo?.hours ? storeStatus(storeInfo.hours, orderFor) : null;
  const storeClosed = menu.length > 0 && storeHours !== null && !storeHours.open;
  const takesNoCards = !ownStore && storeProfile === null;
  const notes = [
    bagIssues.length > 0 && t("cart.bag.blocked"),
    allergiesRefused && t("cart.allergy.blocked"),
    storeInfo && storeInfo.busyExtraMinutes > 0 && t("cart.busy", { minutes: storeInfo.busyExtraMinutes }),
    price.shortOfMinimumCents > 0 && storeInfo?.minOrderCents != null && t("cart.minimum", { minimum: formatCents(storeInfo.minOrderCents), more: formatCents(price.shortOfMinimumCents) }),
    delivery && price.discountedSubtotalCents === 0 && t("cart.freeNoDelivery"),
    takesNoCards && t("cart.noCards"),
    // Closed now, a delivery can be scheduled for when it opens (bags aside).
    storeClosed && (orderFor !== now ? t("cart.closedThen") : delivery && !hasBags ? t("cart.closedSchedule", { status: storeHours.label }) : storeHours.label),
  ].filter((note): note is string => !!note);
  const blocked =
    bagIssues.length > 0 ||
    allergiesRefused ||
    storeClosed ||
    price.shortOfMinimumCents > 0 ||
    (ageRestricted && !ageConfirmed) ||
    takesNoCards ||
    (!ownStore && storeProfile === undefined) ||
    (delivery && (price.discountedSubtotalCents === 0 || maxFeeCents <= 0 || overFeeLimit || overTipLimit || scheduleInvalid || (dropoffPreference === "LeaveAtDoor" && !options.doorRiskAccepted)));

  // An order is placed once, with its card: it stays busy as the page
  // moves on to it, where its payment is followed.
  function placeOrder(payment: PaymentInput | null) {
    if (!cart.catalogRef || !cart.merchant) return;
    const [catalog_ref, merchant] = [cart.catalogRef, cart.merchant];
    const promo_code_ref = discounts.appliedPromo?.hash ?? null;
    const reward = discounts.chosenReward?.id ?? null;
    return action.run(async () => {
      if (!delivery) {
        const record = await requestPickupOrder({
          merchant,
          catalog_ref,
          items: cartItems(cart.lines),
          order_total: price.orderTotalCents,
          kitchen_notes: kitchenNotes.trim(),
          allergies: tellingStore ? allergies : NO_ALLERGIES,
          promo_code_ref,
          reward,
          age_confirmed: ageRestricted && ageConfirmed,
          wake_for_store: wakeTokensForOrder().wake_for_store,
          payment,
        });
        cart.clear();
        navigate(`/customer/pickup-orders/${bytesToHex(actionHash(record))}`);
        return;
      }
      const record = await requestDelivery({
        merchant,
        catalog_ref,
        items: cartItems(cart.lines),
        order_total: price.orderTotalCents,
        dropoff: options.dropoff,
        max_delivery_fee: maxFeeCents,
        kitchen_notes: kitchenNotes.trim(),
        allergies: tellingStore ? allergies : NO_ALLERGIES,
        dropoff_notes: dropoffNotes.trim(),
        dropoff_line2: options.dropoffLine2.trim(),
        tip_cents: tipCents,
        requested_delivery_time: requestedDeliveryTime,
        promo_code_ref,
        reward,
        dropoff_preference: dropoffPreference,
        door_risk_accepted: dropoffPreference === "LeaveAtDoor" && options.doorRiskAccepted,
        priority: options.priority,
        auto_match: options.autoMatch,
        ...wakeTokensForOrder(),
        payment,
      });
      useCustomerSettings.getState().rememberCheckout({ tipPercent: options.tipPercent, feeCapCents: maxFeeCents, dropoffPreference, priority: options.priority, autoMatch: options.autoMatch });
      if (options.saveAsDefault) setSessionLocation(options.dropoff);
      cart.clear();
      navigate(`/customer/orders/${bytesToHex(actionHash(record))}`);
    }, { as: "place", stayBusy: true });
  }

  function saveRecurring(recurrence: RecurrenceRule) {
    if (!cart.catalogRef || !cart.merchant) return;
    const [catalog_ref, merchant] = [cart.catalogRef, cart.merchant];
    return action.run(
      () =>
        createRecurringTemplate({
          merchant,
          catalog_ref,
          items: cartItems(cart.lines),
          dropoff: options.dropoff,
          max_delivery_fee: maxFeeCents,
          kitchen_notes: kitchenNotes.trim(),
          dropoff_notes: dropoffNotes.trim(),
          dropoff_line2: options.dropoffLine2.trim(),
          tip_cents: tipCents,
          dropoff_preference: dropoffPreference,
          priority: options.priority,
          promo_code_ref: discounts.appliedPromo?.hash ?? null,
          recurrence,
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      { as: "recurring" },
    );
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-28 pt-4 lg:px-0 lg:pb-8">
      <motion.button variants={fadeSlideUp} onClick={() => navigate(-1)} className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-500">
        <ArrowLeft size={16} /> {t("common.back")}
      </motion.button>
      <motion.h1 variants={fadeSlideUp} className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        {t("cart.title")}
      </motion.h1>
      <motion.p variants={fadeSlideUp} className="mb-4 text-xs text-ink-400">
        {t("cart.from", { store: cart.merchantName ?? "" })}
      </motion.p>

      {/* The choices, then the summary that places it -- side by side on a wide screen, the summary kept in view. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-8">
        <div className="min-w-0">
          <motion.div variants={fadeSlideUp} className="mb-4 flex gap-2">
            {!ageRestricted && (
              <ToggleChip active={delivery} onClick={() => setFulfillment("Delivery")} className="flex-1 text-center">
                {t("cart.delivery")}
              </ToggleChip>
            )}
            <ToggleChip active={!delivery} onClick={() => setFulfillment("Pickup")} className="flex-1 text-center">
              {t("cart.pickup")}
            </ToggleChip>
          </motion.div>
          {ageRestricted && (
            <motion.label variants={fadeSlideUp} className="mb-4 flex items-start gap-2 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
              <Checkbox checked={ageConfirmed} onChange={(e) => setAgeConfirmed(e.target.checked)} className="mt-0.5" />
              <span>{t("age.confirm", { age: terms.restricted_min_age ?? 18 })}</span>
            </motion.label>
          )}

          <BagNotices problems={bagIssues} delivery={delivery} onSwitch={ageRestricted && !delivery ? null : () => setFulfillment(delivery ? "Pickup" : "Delivery")} />

          <CartLines menuItems={menuItems} program={program} rewardCost={discounts.chosenReward?.cost ?? 0} onEdit={setEditing} />

          {delivery && (
            <>
              <DeliverToSection options={options} preference={dropoffPreference} doorAllowed={price.doorAllowed} store={{ location: storeInfo?.merchantLocation ?? null, radiusKm: storeInfo?.merchantRadiusKm ?? null }} />
              <SpeedSection priority={options.priority} onChange={options.setPriority} storeWaitMinutes={storeInfo?.storeWaitMinutes ?? Math.round(terms.store_wait_secs / 60)} />
              <MatchingSection autoMatch={options.autoMatch} onChange={options.setAutoMatch} />
              {/* A goodie bag is for now, and once. */}
              {!hasBags && <WhenSection options={options} />}
              {/* Brought here from a recurring order: it already repeats. */}
              {!hasBags && !draft && <RepeatSection saving={action.doing === "recurring"} busy={action.busy} onSave={saveRecurring} />}
            </>
          )}

          <AllergySection
            key={JSON.stringify(mine)}
            mine={mine}
            telling={tellingStore}
            onTell={setTellChoice}
            allergies={allergies}
            onAllergies={setChangedAllergies}
            policy={allergyPolicy}
            storeName={cart.merchantName ?? t("cart.theStore")}
            matches={allergyMatches}
          />

          <NoteSection title={t("cart.storeNote")} value={kitchenNotes} onChange={setKitchenNotes} placeholder={t("cart.storeNotePlaceholder")} />

          {delivery && (
            <>
              <NoteSection title={t("cart.dropoffNote")} value={dropoffNotes} onChange={setDropoffNotes} placeholder={t("cart.dropoffNotePlaceholder")} privacy={t("cart.dropoffNotePrivacy")} />
              {/* A driver's bid can be anywhere up to this cap (validate_new_bid
                  rejects anything higher): the customer sets it, so they know at
                  checkout the most delivery can cost. */}
              <Section title={t("cart.feeCap")}>
                <p className="mb-2 text-xs text-ink-400">{t("cart.feeCapDetail")}</p>
                <AmountChoice presets={options.feePresets.filter((fee) => feeLimitCents === null || fee <= feeLimitCents)} label={formatCents} preset={options.feePreset} custom={options.customFee} onPreset={options.setFeePreset} onCustom={options.setCustomFee} placeholder={t("cart.custom")} />
                {overFeeLimit && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{t("cart.feeCapOver", { amount: formatCents(feeLimitCents ?? 0) })}</p>}
              </Section>
              <Section title={t("cart.tipTitle")}>
                <AmountChoice presets={TIP_PRESETS_PERCENT} label={(p) => (p === 0 ? t("cart.noTip") : `${p}%`)} preset={options.tipPercent} custom={options.customTip} onPreset={options.setTipPercent} onCustom={options.setCustomTip} placeholder={t("cart.custom")} />
                {overTipLimit && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{t("cart.tipOver", { amount: formatCents(tipLimitCents ?? 0) })}</p>}
              </Section>
            </>
          )}

          <RewardsSection discounts={discounts} menuItems={menuItems} onBrowse={() => catalogRef && navigate(`/rewards/${bytesToHex(catalogRef)}/redeem`)} />
          {/* Promo codes are the menu's: a cart of goodie bags has nothing for one. */}
          {menu.length > 0 && <PromoSection discounts={discounts} />}
        </div>

        <div className="lg:sticky lg:top-6">
          <p className="hidden text-lg font-bold tracking-tight text-ink-900 lg:block dark:text-ink-50">{t("cart.summary")}</p>
          <CartTotals
            fulfillment={fulfillment}
            subtotalCents={subtotalCents}
            price={price}
            promo={discounts.appliedPromo && { code: discounts.appliedPromo.promo.code, cents: discounts.discountCents }}
            reward={discounts.chosenReward && { name: discounts.chosenReward.name, cents: discounts.rewardDiscountCents }}
            taxRates={taxRates}
            taxIncluded={taxIncluded}
            subsidyPercent={storeInfo?.subsidyPercent ?? 0}
            tipCents={tipCents}
            program={program}
            pointsPreview={pointsPreview}
          />

          <motion.div variants={fadeSlideUp} className="mt-4 rounded-2xl bg-ink-100/60 dark:bg-ink-800/60 p-4 text-xs text-ink-500 dark:text-ink-400">
            {delivery ? t("cart.deliveryNote") : t("cart.pickupNote")}
          </motion.div>

          {action.error && <Notice className="mt-4">{action.error}</Notice>}

          <CheckoutBar
            notes={notes}
            disabled={blocked}
            placing={action.doing === "place"}
            kind={!delivery ? "pickup" : options.scheduled ? "scheduled" : "delivery"}
            totalCents={delivery ? price.estimatedTotalCents : price.orderTotalCents}
            onPlace={() => (ownStore ? placeOrder(null) : setPaying(true))}
          />
        </div>
      </div>

      {paying && storeProfile && (
        <PaySheet
          profile={storeProfile}
          payee={cart.merchantName ?? t("cart.theStore")}
          amountCents={price.holdCents}
          title={t("cart.payTitle", { payee: cart.merchantName ?? t("cart.theStore") })}
          subtitle={delivery ? t("cart.paySubtitleDelivery") : t("cart.paySubtitlePickup")}
          onClose={() => setPaying(false)}
          onCard={async (card) => {
            setPaying(false);
            await placeOrder(card);
          }}
        />
      )}

      {editing && catalogRef && (
        <ItemSheet
          key={editing.key}
          catalogRef={catalogRef}
          row={editing.row}
          editing={editing.line}
          policy={allergyPolicy}
          onClose={() => setEditing(null)}
          onDone={(line) => {
            cart.replaceLine(editing.key, line);
            setEditing(null);
          }}
        />
      )}
      {discounts.rewardSheet}
    </motion.div>
  );
}
