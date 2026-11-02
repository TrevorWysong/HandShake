// Checkout: what's in the bag, how it's to be fulfilled, its one discount,
// what it comes to, and placing it -- paying any shortfall by card first.
// Its parts live beside it: the delivery choices (`useDeliveryOptions`,
// DeliverySections), the discount (`useDiscounts`, DiscountSections), the
// money (`pricing`, CartTotals) and the bar that places it (CheckoutBar).
// What's sent is checked again by the network: totals, discount, range,
// hours and the hold on the balance.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Button, Checkbox, Notice } from "../../../components/ui";
import { CardPaySheet } from "../../../components/money/CardPaySheet";
import { ItemSheet } from "../../../components/store/ItemSheet";
import { cartItems, useCart } from "../../../store/cart";
import { useSession } from "../../../store/session";
import { useCustomerSettings } from "../../../store/roleSettings";
import { useTerms } from "../../../store/network";
import { createRecurringTemplate, requestDelivery, requestPickupOrder } from "../../../holochain/zomes/dispatch";
import { getBalance, listIssuers } from "../../../holochain/zomes/ledger";
import { actionHash, bytesEqual, bytesToHex } from "../../../holochain/decode";
import type { DropoffPreference, RecurrenceRule } from "../../../holochain/types";
import { isPayable, MAX_CARD_PAYMENT_CENTS, MIN_CARD_PAYMENT_CENTS } from "../../../lib/money/issuerService";
import { earnedFor, pointsEarned } from "../../../lib/rewards/rewards";
import { storeStatus } from "../../../lib/storefront/storeHours";
import { wakeTokensForOrder } from "../../../lib/network/push";
import { POLL } from "../../../lib/network/poll";
import { useAction } from "../../../lib/hooks/useAction";
import { useClock } from "../../../lib/hooks/useClock";
import { useResource } from "../../../lib/hooks/useResource";
import { formatCents } from "../../../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../../../lib/ui/motion";
import { useT } from "../../../i18n";
import { AmountChoice, NoteSection, Section, ToggleChip } from "./CartPieces";
import { CartLines, type LineEdit } from "./CartLines";
import { CartTotals } from "./CartTotals";
import { CheckoutBar } from "./CheckoutBar";
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
  // What the order can draw on, and who a shortfall can be paid through by card.
  const { data: balance } = useResource(agentPubKey && `balance:${bytesToHex(agentPubKey)}`, () => getBalance(agentPubKey!), { pollMs: POLL.signalled });
  const { data: payIssuer } = useResource("card-issuer", async () => (await listIssuers()).find(isPayable) ?? null, { pollMs: POLL.slow });

  const options = useDeliveryOptions();
  const discounts = useDiscounts(storeInfo, now);
  // Pickup orders skip the whole driver half of this screen: there's no
  // driver in that vertical at all.
  const [chosenFulfillment, setFulfillment] = useState<"Delivery" | "Pickup">("Delivery");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  // Two notes, each readable only by who it's for: the store (sealed to
  // it) and, for a delivery, the driver (sealed with the address).
  const [kitchenNotes, setKitchenNotes] = useState("");
  const [dropoffNotes, setDropoffNotes] = useState("");
  const [editing, setEditing] = useState<LineEdit | null>(null);
  /// The card payment the order's waiting on, if any.
  const [payingCents, setPayingCents] = useState<number | null>(null);

  const menuItems = storeInfo?.menuItems ?? NO_ITEMS;
  const itemOf = (itemRef: Uint8Array) => menuItems.find((row) => bytesEqual(row.hash, itemRef))?.item;
  // Age-restricted items (alcohol, tobacco) are collected in person, where
  // the store checks ID -- the network's rule.
  const ageRestricted = cart.lines.some((line) => itemOf(line.itemRef)?.age_restricted);
  const fulfillment = ageRestricted ? "Pickup" : chosenFulfillment;
  const delivery = fulfillment === "Delivery";

  const subtotalCents = cart.total();
  const tipCents = tipFor(subtotalCents, options.tipPercent, options.customTip);
  const maxFeeCents = feeCapCents(options.feePreset, options.customFee);
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
    leaveAtDoorMaxCents: storeInfo?.leaveAtDoorMaxCents ?? null,
    balanceCents: balance,
    creditLimitCents: terms.credit_limit_cents,
    card: { available: !!payIssuer, minCents: MIN_CARD_PAYMENT_CENTS, maxCents: MAX_CARD_PAYMENT_CENTS },
  });
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

  const requestedDeliveryTime = scheduledTime(options.scheduled, options.scheduledFor);
  const scheduleInvalid = options.scheduled && (!options.scheduledFor || (requestedDeliveryTime !== null && requestedDeliveryTime <= now.getTime() * 1000));
  // Open when the order's for: now, or a scheduled delivery's time.
  const orderFor = delivery && requestedDeliveryTime !== null ? new Date(requestedDeliveryTime / 1000) : now;
  const storeHours = storeInfo?.hours ? storeStatus(storeInfo.hours, orderFor) : null;
  const storeClosed = storeHours !== null && !storeHours.open;
  const shortUnpayable = price.shortfallCents > 0 && !price.payByCard;
  const notes = [
    storeInfo && storeInfo.busyExtraMinutes > 0 && t("cart.busy", { minutes: storeInfo.busyExtraMinutes }),
    price.shortOfMinimumCents > 0 && storeInfo?.minOrderCents != null && t("cart.minimum", { minimum: formatCents(storeInfo.minOrderCents), more: formatCents(price.shortOfMinimumCents) }),
    delivery && price.discountedSubtotalCents === 0 && t("cart.freeNoDelivery"),
    shortUnpayable && t("cart.short", { amount: formatCents(price.shortfallCents) }),
    storeClosed && (orderFor === now ? storeHours.label : t("cart.closedThen")),
  ].filter((note): note is string => !!note);
  const blocked =
    storeClosed ||
    price.shortOfMinimumCents > 0 ||
    (ageRestricted && !ageConfirmed) ||
    shortUnpayable ||
    (delivery && (price.discountedSubtotalCents === 0 || maxFeeCents <= 0 || scheduleInvalid || (dropoffPreference === "LeaveAtDoor" && !options.doorRiskAccepted)));

  // An order is placed once: it stays busy as the page moves on to it.
  function placeOrder() {
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
          promo_code_ref,
          reward,
          age_confirmed: ageRestricted && ageConfirmed,
          wake_for_store: wakeTokensForOrder().wake_for_store,
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
          door_risk_accepted: dropoffPreference === "LeaveAtDoor" && options.doorRiskAccepted,
          priority: options.priority,
          promo_code_ref: discounts.appliedPromo?.hash ?? null,
          recurrence,
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      { as: "recurring" },
    );
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-28 pt-4">
      <motion.button variants={fadeSlideUp} onClick={() => navigate(-1)} className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-500">
        <ArrowLeft size={16} /> {t("common.back")}
      </motion.button>
      <motion.h1 variants={fadeSlideUp} className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        {t("cart.title")}
      </motion.h1>
      <motion.p variants={fadeSlideUp} className="mb-4 text-xs text-ink-400">
        {t("cart.from", { store: cart.merchantName ?? "" })}
      </motion.p>

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

      <CartLines menuItems={menuItems} program={program} rewardCost={discounts.chosenReward?.cost ?? 0} onEdit={setEditing} />

      {delivery && (
        <>
          <DeliverToSection options={options} preference={dropoffPreference} doorAllowed={price.doorAllowed} store={{ location: storeInfo?.merchantLocation ?? null, radiusKm: storeInfo?.merchantRadiusKm ?? null }} />
          <SpeedSection priority={options.priority} onChange={options.setPriority} storeWaitMinutes={storeInfo?.storeWaitMinutes ?? Math.round(terms.store_wait_secs / 60)} />
          <MatchingSection autoMatch={options.autoMatch} onChange={options.setAutoMatch} />
          <WhenSection options={options} />
          <RepeatSection saving={action.doing === "recurring"} busy={action.busy} onSave={saveRecurring} />
        </>
      )}

      <NoteSection title={t("cart.storeNote")} value={kitchenNotes} onChange={setKitchenNotes} placeholder={t("cart.storeNotePlaceholder")} />

      {delivery && (
        <>
          <NoteSection title={t("cart.dropoffNote")} value={dropoffNotes} onChange={setDropoffNotes} placeholder={t("cart.dropoffNotePlaceholder")} privacy={t("cart.dropoffNotePrivacy")} />
          {/* A driver's bid can be anywhere up to this cap (validate_new_bid
              rejects anything higher): the customer sets it, so they know at
              checkout the most delivery can cost. */}
          <Section title={t("cart.feeCap")}>
            <p className="mb-2 text-xs text-ink-400">{t("cart.feeCapDetail")}</p>
            <AmountChoice presets={options.feePresets} label={formatCents} preset={options.feePreset} custom={options.customFee} onPreset={options.setFeePreset} onCustom={options.setCustomFee} placeholder={t("cart.custom")} />
          </Section>
          <Section title={t("cart.tipTitle")}>
            <AmountChoice presets={TIP_PRESETS_PERCENT} label={(p) => (p === 0 ? t("cart.noTip") : `${p}%`)} preset={options.tipPercent} custom={options.customTip} onPreset={options.setTipPercent} onCustom={options.setCustomTip} placeholder={t("cart.custom")} />
          </Section>
        </>
      )}

      <RewardsSection discounts={discounts} menuItems={menuItems} onBrowse={() => catalogRef && navigate(`/rewards/${bytesToHex(catalogRef)}/redeem`)} />
      <PromoSection discounts={discounts} />

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
        cardCents={price.payByCard ? price.cardChargeCents : null}
        kind={!delivery ? "pickup" : options.scheduled ? "scheduled" : "delivery"}
        totalCents={delivery ? price.estimatedTotalCents : price.orderTotalCents}
        onPlace={placeOrder}
        onPay={() => setPayingCents(price.cardChargeCents)}
      />

      {payingCents !== null && payIssuer && agentPubKey && (
        <CardPaySheet
          issuer={payIssuer}
          agent={agentPubKey}
          amount={payingCents}
          title={t("cart.pay", { amount: formatCents(payingCents) })}
          subtitle={payingCents > price.shortfallCents ? t("cart.payShortMinimum", { minimum: formatCents(MIN_CARD_PAYMENT_CENTS) }) : t("cart.payShort")}
          onClose={() => setPayingCents(null)}
          onPaid={async () => {
            setPayingCents(null);
            await placeOrder();
          }}
        />
      )}

      {editing && catalogRef && (
        <ItemSheet
          key={editing.key}
          catalogRef={catalogRef}
          row={editing.row}
          editing={editing.line}
          onClose={() => setEditing(null)}
          onDone={(line) => {
            cart.replaceLine(editing.key, line);
            setEditing(null);
          }}
        />
      )}
    </motion.div>
  );
}
