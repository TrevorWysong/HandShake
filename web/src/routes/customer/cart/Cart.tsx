import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Minus, Plus, Trash2, ArrowLeft } from "lucide-react";
import { InfoTip } from "../../../components/InfoTip";
import { motion, AnimatePresence } from "framer-motion";
import { Button, Card, Checkbox, Input, Notice, SectionLabel, Select, StatNumber, Textarea } from "../../../components/ui";
import { AddressSwitcher } from "../../../components/places/AddressSwitcher";
import { useCart, cartItems, lineKey, type CartLine } from "../../../store/cart";
import { ItemSheet } from "../../../components/store/ItemSheet";
import { useSession } from "../../../store/session";
import { requestDelivery, requestPickupOrder, createRecurringTemplate } from "../../../holochain/zomes/dispatch";
import { myCard } from "../../../holochain/zomes/rewards";
import { ACCENTS, earnedFor, pointsEarned, rewardDiscount, rewardLine } from "../../../lib/rewards/rewards";
import { RewardRail, RewardTile } from "../../../components/rewards/RewardPieces";
import { Sparkles as RewardsIcon } from "lucide-react";
import { wakeTokensForOrder } from "../../../lib/network/push";
import { actionHash, bytesEqual, bytesToHex, hexToBytes } from "../../../holochain/decode";
import { formatCents, fromMinorUnits, nowMicros, toMinorUnits } from "../../../lib/ui/format";
import { useCustomerSettings } from "../../../store/roleSettings";
import { useTerms } from "../../../store/network";
import { appLocale, useT } from "../../../i18n";
import { describeBlock, describeLimits, describeRequirement, describeReward, evaluatePromo, isPromoEligible } from "../../../lib/storefront/promotions";
import { itemNamer, type ItemRow } from "../../../lib/storefront/menu";
import { fadeSlideUp, staggerContainer } from "../../../lib/ui/motion";
import { useResource } from "../../../lib/hooks/useResource";
import { POLL } from "../../../lib/network/poll";
import { orderTax, totalWithTax } from "../../../lib/storefront/tax";
import { CardPaySheet } from "../../../components/money/CardPaySheet";
import { isPayable, MAX_CARD_PAYMENT_CENTS, MIN_CARD_PAYMENT_CENTS } from "../../../lib/money/issuerService";
import { getBalance, listIssuers } from "../../../holochain/zomes/ledger";
import type { DropoffPreference, GeoPoint, RecurrenceRule } from "../../../holochain/types";
import { useClock } from "../../../lib/hooks/useClock";
import { storeStatus } from "../../../lib/storefront/storeHours";
import { MAX_NOTE_CHARS, MAX_PROMO_CODE_CHARS } from "../../../holochain/types";
import { useAction } from "../../../lib/hooks/useAction";

import { DELIVERY_SPEEDS, DROPOFF_PREFERENCE_OPTIONS, MATCHING, TIP_PRESETS_PERCENT } from "./options";
import { AmountChoice, Section, ToggleChip } from "./CartPieces";
import { bestAutoApplyPromo, fetchCartStoreInfo, NO_ITEMS, NO_PROMOS, validateDropoffRadius, type PromoRow } from "./checkout";

export function Cart() {
  const cart = useCart();
  const location = useSession((s) => s.location);
  const setSessionLocation = useSession((s) => s.setLocation);
  const navigate = useNavigate();
  // Placing the order, or saving it as a recurring one -- one at a time.
  const action = useAction();
  // Two notes, each readable only by who it's for: the store (sealed to
  // it) and, for a delivery, the driver (sealed with the address).
  const [kitchenNotes, setKitchenNotes] = useState("");
  const [dropoffNotes, setDropoffNotes] = useState("");
  // Pickup orders skip the whole driver/dropoff/fee/tip half of this screen
  // entirely -- there's no driver in that vertical at all, see
  // `PickupOrder`'s own doc comment (`dispatch_integrity`) for why that's a
  // separate entry type, not a flag on this same order.
  const [chosenFulfillment, setFulfillment] = useState<"Delivery" | "Pickup">("Delivery");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  // Defaults to the session's saved location, but editable per order --
  // previously frozen at whatever was set once during onboarding, with no
  // way to deliver anywhere else (e.g. a friend's place) or update it after
  // moving.
  const [dropoff, setDropoff] = useState<GeoPoint>(location);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  // Checkout starts as the customer last left it.
  const [usual] = useState(() => useCustomerSettings.getState().checkout);
  const feePresets = useTerms().suggested_delivery_fees;
  const [chosenPreference, setDropoffPreference] = useState<DropoffPreference>(usual.dropoffPreference);
  // Leaving it at the door means accepting it's delivered once it's left --
  // asked each time it's chosen.
  const [doorRiskAccepted, setDoorRiskAccepted] = useState(false);
  const [showRecurring, setShowRecurring] = useState(false);
  const [recurrenceKind, setRecurrenceKind] = useState<"Daily" | "Weekly">("Weekly");
  const [recurrenceWeekday, setRecurrenceWeekday] = useState(1); // Monday
  const [recurrenceTime, setRecurrenceTime] = useState("09:00");
  /// A line whose choices are being changed.
  const [editing, setEditing] = useState<{ key: string; line: CartLine; row: ItemRow } | null>(null);
  const [recurringSaved, setRecurringSaved] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [priority, setPriority] = useState(usual.priority);
  const [autoMatch, setAutoMatch] = useState(usual.autoMatch);
  const [scheduledFor, setScheduledFor] = useState("");
  const [tipPercent, setTipPercent] = useState<number | null>(usual.tipPercent);
  const [customTip, setCustomTip] = useState("");
  const [feePreset, setFeePreset] = useState<number | null>(() => {
    if (usual.feeCapCents !== null && feePresets.includes(usual.feeCapCents)) return usual.feeCapCents;
    if (usual.feeCapCents !== null) return null;
    return feePresets[Math.min(1, feePresets.length - 1)];
  });
  const [customFee, setCustomFee] = useState(() => (usual.feeCapCents !== null && !feePresets.includes(usual.feeCapCents) ? String(fromMinorUnits(usual.feeCapCents)) : ""));
  const catalogRef = cart.catalogRef;
  const now = useClock();
  const { data: storeInfo } = useResource(catalogRef && `cart-store:${bytesToHex(catalogRef)}`, () => fetchCartStoreInfo(catalogRef!));
  // How late the store may run before a driver can leave it paid and the
  // customer cancel for nothing -- its own, or the network's.
  const networkWaitSecs = useTerms().store_wait_secs;
  const creditLimitCents = useTerms().credit_limit_cents;
  // What the order can draw on, and who it can be topped up through by card
  // when that's short.
  const agentPubKey = useSession((s) => s.agentPubKey);
  const { data: balance } = useResource(agentPubKey && `balance:${bytesToHex(agentPubKey)}`, () => getBalance(agentPubKey!), { pollMs: POLL.signalled });
  const { data: payIssuer } = useResource("card-issuer", async () => (await listIssuers()).find(isPayable) ?? null, { pollMs: POLL.slow });
  /// The card payment the order's waiting on, if any.
  const [payingCents, setPayingCents] = useState<number | null>(null);
  const storeWaitMinutes = storeInfo?.storeWaitMinutes ?? Math.round(networkWaitSecs / 60);
  const subsidyPercent = storeInfo?.subsidyPercent ?? 0;
  const merchantLocation = storeInfo?.merchantLocation ?? null;
  const merchantRadiusKm = storeInfo?.merchantRadiusKm ?? null;
  const promoCodes = storeInfo?.promoCodes ?? NO_PROMOS;
  const menuItems = storeInfo?.menuItems ?? NO_ITEMS;
  const completedOrderCount = storeInfo?.completedOrderCount ?? 0;
  const [promoInput, setPromoInput] = useState("");
  // A code the customer typed always wins. Otherwise the best *eligible,
  // auto_apply* code (a loyalty reward, say) applies by itself -- computed
  // from the live cart every render rather than picked once by an effect,
  // so adding/removing items re-evaluates which auto code (if any)
  // currently qualifies. Removing an auto-applied code dismisses auto-apply
  // for this cart visit.
  const [manualPromo, setManualPromo] = useState<PromoRow | null>(null);
  const [autoPromoDismissed, setAutoPromoDismissed] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const cartTotal = cart.total();
  // Re-chosen as the clock moves, too: a promo expiring while the cart is
  // open stops applying then, not whenever something else changes.
  const nowUs = now.getTime() * 1000;
  const autoPromo = useMemo(
    () => (autoPromoDismissed ? null : bestAutoApplyPromo(promoCodes, cart.lines, cartTotal, completedOrderCount, nowUs)),
    [autoPromoDismissed, promoCodes, cart.lines, cartTotal, completedOrderCount, nowUs],
  );
  // The store's rewards program: a reward chosen takes the place of any
  // promo (the network allows one discount an order).
  const catalogHex = cart.catalogRef ? bytesToHex(cart.catalogRef) : null;
  const { data: rewardsCard } = useResource(catalogHex ? `rewards:card:${catalogHex}` : null, () => myCard(hexToBytes(catalogHex!)));
  const rewardsProgram = rewardsCard?.program?.program.active ? rewardsCard.program.program : null;
  // The reward redeemed into the bag, as the program offers it now.
  const chosenReward = (cart.reward && rewardsProgram?.rewards.find((r) => r.id === cart.reward!.id)) || null;
  const heldPoints = chosenReward?.cost ?? 0;
  /// Puts a reward in the bag -- or takes it out, tapped again.
  const toggleReward = (reward: NonNullable<typeof chosenReward>) => {
    if (chosenReward?.id === reward.id) return cart.releaseReward();
    cart.redeem(cart.catalogRef!, cart.merchant!, cart.merchantName ?? "", { id: reward.id, name: reward.name, cost: reward.cost }, rewardLine(reward, menuItems));
  };
  // A deal chosen on the store's page, if it's this store's and theirs to use.
  const dealPromo = promoCodes.find((p) => cart.promoHex === bytesToHex(p.hash) && !p.standing?.blocked) ?? null;
  const appliedPromo = chosenReward ? null : (manualPromo ?? dealPromo ?? autoPromo);

  const itemName = itemNamer(menuItems);

  function applyPromo() {
    setPromoError(null);
    const typed = promoInput.trim().toUpperCase();
    const now = nowMicros();
    const match = promoCodes.find((p) => p.promo.code.toUpperCase() === typed && p.promo.active && (p.promo.expires_at === null || p.promo.expires_at > now));
    if (!match) {
      setPromoError(t("cart.promo.invalid"));
      return;
    }
    if (match.standing?.blocked) {
      setPromoError(describeBlock(match.standing.blocked));
      return;
    }
    if (!isPromoEligible(match.promo.requirement, cart.lines, cart.total(), completedOrderCount)) {
      setPromoError(t("cart.promo.notYet", { requirement: describeRequirement(match.promo.requirement, itemName) }));
      return;
    }
    setManualPromo(match);
  }

  const tipCents = tipPercent !== null ? Math.round((cart.total() * tipPercent) / 100) : toMinorUnits(Number(customTip || 0));
  const maxFeeCents = feePreset !== null ? feePreset : toMinorUnits(Number(customFee || 0));
  // Worst case (a winning bid right at the cap): mirrors the settlement
  // split in dispatch_types::split_delivery_fee exactly -- the store's share
  // floor-rounded, the customer's the remainder.
  const customerFeeShareCents = maxFeeCents - Math.floor((maxFeeCents * subsidyPercent) / 100);
  // Re-evaluated against the *current* cart every render, not just at the
  // moment the code was applied -- a requirement can stop being met (e.g.
  // the qualifying item gets removed) or a reward can newly become
  // redeemable (e.g. a "spend $X get item Y free" code applied before Y was
  // added), and the summary should reflect that live, not the stale state
  // from when "Apply" was clicked.
  const promoEvaluation = appliedPromo ? evaluatePromo(appliedPromo.promo, cart.lines, cart.total(), completedOrderCount) : null;
  const rewardDiscountCents = chosenReward ? rewardDiscount(chosenReward.benefit, cart.lines) : 0;
  const promoDiscountCents = chosenReward ? rewardDiscountCents : (promoEvaluation?.effect.subtotalDiscountCents ?? 0);
  const promoRewardNeedsItem = appliedPromo ? "FreeItem" in appliedPromo.promo.reward || "PercentOffItem" in appliedPromo.promo.reward : false;
  const promoAwaitingRewardItem = !!appliedPromo && !!promoEvaluation?.eligible && promoRewardNeedsItem && promoEvaluation.effect.itemEffects.length === 0;
  const discountedSubtotalCents = cart.total() - promoDiscountCents;
  // The store's tax on the food after any promo, as validation computes it
  // (`lib/storefront/tax.ts`): added on top, or already in the prices.
  // Age-restricted items (alcohol, tobacco) are collected in person, where
  // the store checks ID -- the network's rule.
  const itemOf = (itemRef: Uint8Array) => storeInfo?.menuItems.find((row) => bytesEqual(row.hash, itemRef))?.item;
  const ageRestricted = cart.lines.some((line) => itemOf(line.itemRef)?.age_restricted);
  const minAge = useTerms().restricted_min_age;
  const t = useT();
  const fulfillment: "Delivery" | "Pickup" = ageRestricted ? "Pickup" : chosenFulfillment;
  const taxCategoryOf = (itemRef: Uint8Array) => storeInfo?.menuItems.find((row) => bytesEqual(row.hash, itemRef))?.item.tax_category ?? "";
  const taxRates = storeInfo?.taxRates ?? [];
  const taxIncluded = storeInfo?.pricesIncludeTax ?? false;
  const taxCents = orderTax(
    cart.lines.map((line) => ({ category: taxCategoryOf(line.itemRef), total: line.priceCents * line.quantity })),
    discountedSubtotalCents,
    taxRates,
    taxIncluded,
  );
  /// What the store is paid: the food, and its tax.
  const orderTotalCents = totalWithTax(discountedSubtotalCents, taxCents, taxIncluded);
  // What it earns, as the program will count it once the store settles:
  // the food paid, without tax.
  const pointsPreview = rewardsProgram
    ? earnedFor(rewardsProgram, rewardsCard?.state ?? null, pointsEarned(rewardsProgram, cart.lines.map((l) => ({ itemRef: l.itemRef, totalCents: l.priceCents * l.quantity })), discountedSubtotalCents - (taxIncluded ? taxCents : 0), now.getTime() * 1000))
    : 0;
  // The store's limit on what may be left at a door; above it, the order is
  // handed over whatever was chosen.
  // The store's minimum is on the menu prices, before any promo.
  const shortOfMinimum = storeInfo?.minOrderCents != null ? Math.max(0, storeInfo.minOrderCents - cart.total()) : 0;
  const doorAllowed = storeInfo?.leaveAtDoorMaxCents == null || orderTotalCents <= storeInfo.leaveAtDoorMaxCents;
  const dropoffPreference: DropoffPreference = chosenPreference === "LeaveAtDoor" && !doorAllowed ? "HandToMe" : chosenPreference;
  const estimatedTotalCents = orderTotalCents + tipCents + customerFeeShareCents;
  // What placing it sets aside from the balance, which may run down to the
  // network's credit limit; a shortfall is paid by card first -- at least
  // the least a card payment may be.
  const orderHoldCents = fulfillment === "Pickup" ? orderTotalCents : estimatedTotalCents;
  const shortfallCents = balance === undefined ? 0 : Math.max(0, orderHoldCents - (balance + creditLimitCents));
  const cardChargeCents = Math.max(shortfallCents, MIN_CARD_PAYMENT_CENTS);
  const payByCard = shortfallCents > 0 && !!payIssuer && cardChargeCents <= MAX_CARD_PAYMENT_CENTS;

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

  // Holochain Timestamps are microseconds since epoch; <input type=
  // "datetime-local"> gives a local-time string with no timezone info --
  // Date.parse treats it as local time already, matching what the customer
  // actually picked, so no further conversion is needed beyond ms -> µs.
  const requestedDeliveryTime = scheduled && scheduledFor ? Date.parse(scheduledFor) * 1000 : null;
  const scheduleInvalid = scheduled && (!scheduledFor || (requestedDeliveryTime !== null && requestedDeliveryTime <= now.getTime() * 1000));
  // Open when the order's for: now, or a scheduled delivery's time. A
  // goodie bag isn't in the cart -- it runs on its own pickup window.
  const orderFor = fulfillment === "Delivery" && requestedDeliveryTime !== null ? new Date(requestedDeliveryTime / 1000) : now;
  const storeHours = storeInfo?.hours ? storeStatus(storeInfo.hours, orderFor) : null;
  const storeClosed = storeHours !== null && !storeHours.open;

  // An order is placed once: it stays busy as the page moves on to it.
  function placeOrder() {
    if (!cart.catalogRef || !cart.merchant) return;
    const [catalogRef, merchant] = [cart.catalogRef, cart.merchant];
    return action.run(async () => {
      if (fulfillment === "Pickup") {
        const record = await requestPickupOrder({
          merchant,
          catalog_ref: catalogRef,
          items: cartItems(cart.lines),
          order_total: orderTotalCents,
          kitchen_notes: kitchenNotes.trim(),
          promo_code_ref: appliedPromo?.hash ?? null,
          reward: chosenReward?.id ?? null,
          age_confirmed: ageRestricted && ageConfirmed,
          wake_for_store: wakeTokensForOrder().wake_for_store,
        });
        cart.clear();
        navigate(`/customer/pickup-orders/${bytesToHex(actionHash(record))}`);
        return;
      }
      const record = await requestDelivery({
        merchant,
        catalog_ref: catalogRef,
        items: cartItems(cart.lines),
        order_total: orderTotalCents,
        dropoff,
        max_delivery_fee: maxFeeCents,
        kitchen_notes: kitchenNotes.trim(),
        dropoff_notes: dropoffNotes.trim(),
        tip_cents: tipCents,
        requested_delivery_time: requestedDeliveryTime,
        promo_code_ref: appliedPromo?.hash ?? null,
        reward: chosenReward?.id ?? null,
        dropoff_preference: dropoffPreference,
        door_risk_accepted: dropoffPreference === "LeaveAtDoor" && doorRiskAccepted,
        priority,
        auto_match: autoMatch,
        ...wakeTokensForOrder(),
      });
      useCustomerSettings.getState().rememberCheckout({ tipPercent, feeCapCents: maxFeeCents, dropoffPreference, priority, autoMatch });
      if (saveAsDefault) setSessionLocation(dropoff);
      cart.clear();
      navigate(`/customer/orders/${bytesToHex(actionHash(record))}`);
    }, { as: "place", stayBusy: true });
  }

  function saveRecurring() {
    if (!cart.catalogRef || !cart.merchant) return;
    const [catalogRef, merchant] = [cart.catalogRef, cart.merchant];
    const [hour, minute] = recurrenceTime.split(":").map(Number);
    const recurrence: RecurrenceRule = recurrenceKind === "Daily" ? { Daily: { hour, minute } } : { Weekly: { weekday: recurrenceWeekday, hour, minute } };
    return action.run(async () => {
      await createRecurringTemplate({
        merchant,
        catalog_ref: catalogRef,
        items: cartItems(cart.lines),
        dropoff,
        max_delivery_fee: maxFeeCents,
        kitchen_notes: kitchenNotes.trim(),
        dropoff_notes: dropoffNotes.trim(),
        tip_cents: tipCents,
        dropoff_preference: dropoffPreference,
        door_risk_accepted: dropoffPreference === "LeaveAtDoor" && doorRiskAccepted,
        priority,
        promo_code_ref: appliedPromo?.hash ?? null,
        recurrence,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setRecurringSaved(true);
      setShowRecurring(false);
    }, { as: "recurring" });
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
          <ToggleChip active={fulfillment === "Delivery"} onClick={() => setFulfillment("Delivery")} className="flex-1 text-center">
            {t("cart.delivery")}
          </ToggleChip>
        )}
        <ToggleChip active={fulfillment === "Pickup"} onClick={() => setFulfillment("Pickup")} className="flex-1 text-center">
          {t("cart.pickup")}
        </ToggleChip>
      </motion.div>
      {ageRestricted && (
        <motion.label variants={fadeSlideUp} className="mb-4 flex items-start gap-2 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          <Checkbox checked={ageConfirmed} onChange={(e) => setAgeConfirmed(e.target.checked)} className="mt-0.5" />
          <span>{t("age.confirm", { age: minAge ?? 18 })}</span>
        </motion.label>
      )}

      <motion.div variants={fadeSlideUp}>
        <Card className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800">
          {cart.lines.map((line) => {
            const key = lineKey(line);
            const row = line.selections.length > 0 ? menuItems.find((m) => bytesEqual(m.hash, line.itemRef)) : undefined;
            if (line.rewardId != null && rewardsProgram) {
              const colors = ACCENTS[rewardsProgram.accent];
              return (
                <motion.div key={key} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3 p-4" style={{ backgroundImage: `linear-gradient(90deg, ${colors.from}14, transparent)` }}>
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white" style={{ backgroundImage: `linear-gradient(135deg, ${colors.from}, ${colors.to})` }}>
                    <RewardsIcon size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">
                      {line.quantity > 1 && `${line.quantity}× `}
                      {line.name}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs">
                      <span className="rounded-full px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-white" style={{ background: colors.to }}>
                        {t("cart.reward.badge")}
                      </span>
                      <span className="font-semibold tabular-nums" style={{ color: colors.to }}>
                        {t("cart.reward.points", { points: (chosenReward?.cost ?? 0).toLocaleString(), name: rewardsProgram.points_name })}
                      </span>
                    </p>
                  </div>
                  <motion.button whileTap={{ scale: 0.85 }} onClick={() => cart.removeLine(key)} aria-label={t("redeem.remove")} className="grid h-7 w-7 place-items-center rounded-full hover:bg-ink-100 dark:hover:bg-ink-800">
                    <Trash2 size={14} className="text-ink-400" />
                  </motion.button>
                  <div className="w-16 text-right leading-tight">
                    <p className="text-xs tabular-nums text-ink-400 line-through">{formatCents(line.priceCents * line.quantity)}</p>
                    <p className="text-sm font-black" style={{ color: colors.to }}>
                      {t("cart.reward.free")}
                    </p>
                  </div>
                </motion.div>
              );
            }
            return (
              <div key={key} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{line.name}</p>
                  {line.choiceLabels.length > 0 && <p className="line-clamp-2 text-xs text-ink-500 dark:text-ink-400">{line.choiceLabels.join(", ")}</p>}
                  <p className="text-xs text-ink-400">
                    {t("cart.each", { price: formatCents(line.priceCents) })}
                    {row && (
                      <button type="button" onClick={() => setEditing({ key, line, row })} className="ml-2 font-semibold text-handshake-600 hover:underline dark:text-handshake-400">
                        {t("common.edit")}
                      </button>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-full bg-ink-100 dark:bg-ink-800 px-1.5 py-1">
                  <motion.button whileTap={{ scale: 0.85 }} onClick={() => cart.setQuantity(key, line.quantity - 1)} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 dark:hover:bg-ink-700">
                    {line.quantity === 1 ? <Trash2 size={14} className="text-ink-400" /> : <Minus size={14} className="text-ink-400" />}
                  </motion.button>
                  <span className="w-4 text-center text-sm font-semibold">{line.quantity}</span>
                  <motion.button whileTap={{ scale: 0.85 }} onClick={() => cart.setQuantity(key, line.quantity + 1)} className="grid h-6 w-6 place-items-center rounded-full hover:bg-ink-200 dark:hover:bg-ink-700">
                    <Plus size={14} className="text-ink-400" />
                  </motion.button>
                </div>
                <StatNumber className="w-16 text-right text-sm">{formatCents(line.priceCents * line.quantity)}</StatNumber>
              </div>
            );
          })}
        </Card>
      </motion.div>

      {fulfillment === "Delivery" && (
        <Section title={t("cart.deliverTo")}>
          <AddressSwitcher
            value={dropoff}
            onChange={setDropoff}
            onValidate={(point) => validateDropoffRadius(point, merchantLocation, merchantRadiusKm)}
            label={t("cart.deliverTo")}
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-400">
            <Checkbox checked={saveAsDefault} onChange={(e) => setSaveAsDefault(e.target.checked)} />
            {t("cart.saveDefault")}
          </label>
          <SectionLabel className="mb-2 mt-3">{t("cart.dropoff")}</SectionLabel>
          <div className="flex gap-2">
            {DROPOFF_PREFERENCE_OPTIONS.filter(({ value }) => value !== "LeaveAtDoor" || doorAllowed).map(({ value, label }) => (
              <ToggleChip
                key={value}
                active={dropoffPreference === value}
                onClick={() => {
                  setDropoffPreference(value);
                  setDoorRiskAccepted(false);
                }}
                className="flex-1"
              >
                {t(label)}
              </ToggleChip>
            ))}
          </div>
          {dropoffPreference === "LeaveAtDoor" ? (
            <label className="mt-3 flex items-start gap-2.5 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">
              <Checkbox checked={doorRiskAccepted} onChange={(e) => setDoorRiskAccepted(e.target.checked)} className="mt-0.5" />
              <span>
                <span className="font-semibold">{t("cart.door.risk")}</span> {t("cart.door.riskDetail")}
              </span>
            </label>
          ) : (
            <p className="mt-2 text-xs text-ink-400">{t("cart.door.code")}</p>
          )}
          {!doorAllowed && <p className="mt-1 text-xs text-ink-400">{t("cart.door.tooLarge")}</p>}
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section
          title={t("cart.delivery")}
          right={
            <InfoTip label={t("cart.late.label")}>
              <p className="font-semibold text-ink-900 dark:text-ink-50">{t("cart.late.title")}</p>
              <p className="mt-1">{t("cart.late.storeWait", { minutes: storeWaitMinutes })}</p>
              <p className="mt-1">{t("cart.late.noDriver")}</p>
            </InfoTip>
          }
        >
          <div className="flex gap-2">
            {DELIVERY_SPEEDS.map(({ priority: value, label }) => (
              <ToggleChip key={label} active={priority === value} onClick={() => setPriority(value)} className="flex-1">
                {t(label)}
              </ToggleChip>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-400">{t(DELIVERY_SPEEDS.find((speed) => speed.priority === priority)!.detail)}</p>
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section title={t("cart.driver")}>
          <div className="flex gap-2">
            {MATCHING.map(({ autoMatch: value, label }) => (
              <ToggleChip key={label} active={autoMatch === value} onClick={() => setAutoMatch(value)} className="flex-1">
                {t(label)}
              </ToggleChip>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-400">{t(MATCHING.find((m) => m.autoMatch === autoMatch)!.detail)}</p>
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section title={t("cart.when")}>
          <div className="mb-2 flex gap-2">
            <ToggleChip active={!scheduled} onClick={() => setScheduled(false)}>
              {t("cart.now")}
            </ToggleChip>
            <ToggleChip active={scheduled} onClick={() => setScheduled(true)}>
              {t("cart.later")}
            </ToggleChip>
          </div>
          <AnimatePresence initial={false}>
            {scheduled && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                <Input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
                <p className="mt-1 text-xs text-ink-400">{t("cart.laterDetail")}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section
          title={t("cart.repeat.title")}
          right={
            <button onClick={() => setShowRecurring((v) => !v)} className="text-xs font-semibold text-handshake-600">
              {showRecurring ? t("common.cancel") : recurringSaved ? t("common.edit") : t("cart.repeat.setUp")}
            </button>
          }
        >
          {recurringSaved && !showRecurring && <p className="text-xs text-presence-600">{t("cart.repeat.saved")}</p>}
          <AnimatePresence initial={false}>
            {showRecurring && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <ToggleChip active={recurrenceKind === "Weekly"} onClick={() => setRecurrenceKind("Weekly")} className="flex-1">
                    {t("cart.repeat.weekly")}
                  </ToggleChip>
                  <ToggleChip active={recurrenceKind === "Daily"} onClick={() => setRecurrenceKind("Daily")} className="flex-1">
                    {t("cart.repeat.daily")}
                  </ToggleChip>
                </div>
                {recurrenceKind === "Weekly" && (
                  <Select value={recurrenceWeekday} onChange={(e) => setRecurrenceWeekday(Number(e.target.value))}>
                    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                      <option key={i} value={i}>
                        {new Date(2024, 0, 7 + i).toLocaleDateString(appLocale(), { weekday: "long" })}
                      </option>
                    ))}
                  </Select>
                )}
                <Input type="time" value={recurrenceTime} onChange={(e) => setRecurrenceTime(e.target.value)} />
                <p className="text-xs text-ink-400">{t("cart.repeat.detail")}</p>
                <Button loading={action.doing === "recurring"} disabled={action.busy} onClick={saveRecurring} className="py-2 text-xs">
                  {t("cart.repeat.save")}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </Section>
      )}

      <Section title={t("cart.storeNote")}>
        <Textarea maxLength={MAX_NOTE_CHARS} value={kitchenNotes} onChange={(e) => setKitchenNotes(e.target.value)} rows={2} placeholder={t("cart.storeNotePlaceholder")} />
      </Section>

      {fulfillment === "Delivery" && (
        <Section title={t("cart.dropoffNote")}>
          <Textarea maxLength={MAX_NOTE_CHARS} value={dropoffNotes} onChange={(e) => setDropoffNotes(e.target.value)} rows={2} placeholder={t("cart.dropoffNotePlaceholder")} />
          <p className="mt-1.5 text-[11px] text-ink-400">{t("cart.dropoffNotePrivacy")}</p>
        </Section>
      )}

      {/* A driver's bid can be anywhere up to this cap (validate_new_bid
          rejects anything higher): the customer sets it, so they know at
          checkout the most delivery can cost. */}
      {fulfillment === "Delivery" && (
        <Section title={t("cart.feeCap")}>
          <p className="mb-2 text-xs text-ink-400">{t("cart.feeCapDetail")}</p>
          <AmountChoice presets={feePresets} label={formatCents} preset={feePreset} custom={customFee} onPreset={setFeePreset} onCustom={setCustomFee} placeholder={t("cart.custom")} />
        </Section>
      )}

      {fulfillment === "Delivery" && (
        <Section title={t("cart.tipTitle")}>
          <AmountChoice presets={TIP_PRESETS_PERCENT} label={(p) => (p === 0 ? t("cart.noTip") : `${p}%`)} preset={tipPercent} custom={customTip} onPreset={setTipPercent} onCustom={setCustomTip} placeholder={t("cart.custom")} />
        </Section>
      )}

      {rewardsProgram && rewardsProgram.rewards.length > 0 && (
        <Section
          title={rewardsProgram.name}
          right={
            <span className="text-xs font-black tabular-nums" style={{ color: ACCENTS[rewardsProgram.accent].to }}>
              {Math.max(0, rewardsCard!.balance - heldPoints).toLocaleString()} {rewardsProgram.points_name}
              {heldPoints > 0 && <span className="ml-1 font-semibold text-ink-400">· {t("cart.reward.held", { points: heldPoints.toLocaleString() })}</span>}
            </span>
          }
        >
          <RewardRail>
            {[...rewardsProgram.rewards]
              .sort((a, b) => a.cost - b.cost)
              .map((reward) => (
                <RewardTile key={reward.id} program={rewardsProgram} reward={reward} balance={rewardsCard!.balance} tier={rewardsCard!.tier} menu={menuItems} selected={chosenReward?.id === reward.id} onSelect={() => toggleReward(reward)} />
              ))}
          </RewardRail>
          {chosenReward && rewardDiscountCents === 0 && <p className="mt-1 text-xs text-amber-600">{t("rewards.addItemToUse")}</p>}
          {chosenReward && rewardDiscountCents > 0 && <p className="mt-1 text-xs text-ink-500">{t("rewards.usingInstead")}</p>}
          <button type="button" onClick={() => navigate(`/rewards/${catalogHex}/redeem`)} className="mt-2 text-xs font-bold hover:underline" style={{ color: ACCENTS[rewardsProgram.accent].to }}>
            {t("cart.reward.browse")} →
          </button>
        </Section>
      )}

      {!chosenReward && <Section title={t("cart.promo.title")}>
        <AnimatePresence mode="wait">
          {appliedPromo ? (
            <motion.div
              key="applied"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              className="rounded-lg bg-presence-500/10 px-3 py-2 text-sm text-presence-600 dark:text-presence-400"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono font-semibold">
                  {appliedPromo.promo.auto_apply && <span className="mr-1.5 rounded-full bg-presence-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">🎁 {t("cart.promo.loyalty")}</span>}
                  {appliedPromo.promo.code}
                </span>
                <button
                  onClick={() => {
                    if (manualPromo) setManualPromo(null);
                    else if (dealPromo) cart.choosePromo(null);
                    else setAutoPromoDismissed(true);
                    setPromoInput("");
                  }}
                  className="text-xs underline"
                >
                  {t("common.remove")}
                </button>
              </div>
              <p className="mt-0.5 text-xs opacity-80">{describeReward(appliedPromo.promo.reward, itemName)}</p>
              {describeLimits(appliedPromo.promo, appliedPromo.standing).length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {describeLimits(appliedPromo.promo, appliedPromo.standing).map((chip) => (
                    <span key={chip} className="rounded-full bg-presence-500/15 px-2 py-0.5 text-[10px] font-semibold">
                      {chip}
                    </span>
                  ))}
                </div>
              )}
              {!promoEvaluation?.eligible && <p className="mt-1 text-xs text-red-600">{t("cart.promo.noLonger", { requirement: describeRequirement(appliedPromo.promo.requirement, itemName) })}</p>}
              {promoAwaitingRewardItem && <p className="mt-1 text-xs text-amber-600">{t("cart.promo.addItem")}</p>}
            </motion.div>
          ) : (
            <motion.div key="unapplied" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex gap-2">
              <Input maxLength={MAX_PROMO_CODE_CHARS} value={promoInput} onChange={(e) => setPromoInput(e.target.value)} placeholder={t("cart.promo.enter")} className="flex-1 font-mono" />
              <Button variant="ghost" className="px-4 py-2 text-xs" onClick={applyPromo}>
                {t("cart.promo.apply")}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
        {promoError && <p className="mt-1 text-xs text-red-600">{promoError}</p>}
      </Section>}

      <motion.div variants={fadeSlideUp}>
        <Card className="mt-4 flex flex-col gap-1.5 p-4 text-sm">
          <div className="flex justify-between text-ink-400">
            <span>{t("cart.subtotal")}</span>
            <span>{formatCents(cart.total())}</span>
          </div>
          {appliedPromo && (
            <div className="flex justify-between text-presence-600 dark:text-presence-400">
              <span>{t("cart.promoLine", { code: appliedPromo.promo.code })}</span>
              <span>-{formatCents(promoDiscountCents)}</span>
            </div>
          )}
          {chosenReward && rewardDiscountCents > 0 && (
            <div className="flex justify-between font-semibold" style={{ color: ACCENTS[rewardsProgram!.accent].to }}>
              <span>{chosenReward.name}</span>
              <span>-{formatCents(rewardDiscountCents)}</span>
            </div>
          )}
          {taxRates.length > 0 && !taxIncluded && (
            <div className="flex justify-between text-ink-400">
              <span>{taxRates[0].label || t("cart.tax")}</span>
              <span>{formatCents(taxCents)}</span>
            </div>
          )}
          {fulfillment === "Delivery" && (
            <div className="flex justify-between text-ink-400">
              <span>
                {t("cart.deliveryFee")}
                {subsidyPercent > 0 && <span className="text-presence-600"> {t("cart.storeCovers", { percent: subsidyPercent })}</span>}
              </span>
              <span>{t("cart.upTo", { amount: formatCents(customerFeeShareCents) })}</span>
            </div>
          )}
          {fulfillment === "Delivery" && (
            <div className="flex justify-between text-ink-400">
              <span>{t("cart.tip")}</span>
              <span>{formatCents(tipCents)}</span>
            </div>
          )}
          <div className="mt-1 flex items-center justify-between border-t border-ink-100 dark:border-ink-800 pt-2">
            <span className="font-bold text-ink-900 dark:text-ink-50">{t("cart.estimatedTotal")}</span>
            {fulfillment === "Delivery" && <span className="text-ink-400 text-xs mr-1">{t("cart.upToShort")}</span>}
            <StatNumber className="text-lg">{formatCents(fulfillment === "Pickup" ? orderTotalCents : estimatedTotalCents)}</StatNumber>
          </div>
          {taxRates.length > 0 && taxIncluded && taxCents > 0 && (
            <p className="text-right text-xs text-ink-400">
              {t("cart.includesTax", { amount: formatCents(taxCents), tax: taxRates[0].label || t("cart.taxLower") })}
            </p>
          )}
          {rewardsProgram && pointsPreview > 0 && (
            <p className="mt-1 flex items-center justify-end gap-1 text-xs font-bold" style={{ color: ACCENTS[rewardsProgram.accent].to }}>
              <RewardsIcon size={12} /> {t("rewards.willEarn", { points: pointsPreview.toLocaleString(), name: rewardsProgram.points_name })}
            </p>
          )}
          {rewardsProgram && pointsPreview > 0 && (
            <p className="text-right text-[11px] text-ink-400">{t("rewards.arriveAfterRefunds")}</p>
          )}
        </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mt-4 rounded-2xl bg-ink-100/60 dark:bg-ink-800/60 p-4 text-xs text-ink-500 dark:text-ink-400">
        {fulfillment === "Pickup" ? t("cart.pickupNote") : t("cart.deliveryNote")}
      </motion.div>

      {action.error && <Notice className="mt-4">{action.error}</Notice>}

      <div className="fixed inset-x-0 bottom-20 z-20 mx-auto flex max-w-md flex-col items-center gap-2 px-4">
        {storeInfo && storeInfo.busyExtraMinutes > 0 && (
          <p className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
            {t("cart.busy", { minutes: storeInfo.busyExtraMinutes })}
          </p>
        )}
        {shortOfMinimum > 0 && storeInfo?.minOrderCents != null && (
          <p className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
            {t("cart.minimum", { minimum: formatCents(storeInfo.minOrderCents), more: formatCents(shortOfMinimum) })}
          </p>
        )}
        {fulfillment === "Delivery" && discountedSubtotalCents === 0 && (
          <p className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
            {t("cart.freeNoDelivery")}
          </p>
        )}
        {shortfallCents > 0 && !payByCard && (
          <p className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
            {t("cart.short", { amount: formatCents(shortfallCents) })}
          </p>
        )}
        {storeClosed && (
          <p className="w-full rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">
            {orderFor === now ? storeHours.label : t("cart.closedThen")}
          </p>
        )}
        <Button
          className="w-full"
          loading={action.doing === "place"}
          disabled={
            storeClosed ||
            shortOfMinimum > 0 ||
            (ageRestricted && !ageConfirmed) ||
            (shortfallCents > 0 && !payByCard) ||
            (fulfillment === "Delivery" && (discountedSubtotalCents === 0 || maxFeeCents <= 0 || scheduleInvalid || (dropoffPreference === "LeaveAtDoor" && !doorRiskAccepted)))
          }
          onClick={payByCard ? () => setPayingCents(cardChargeCents) : placeOrder}
        >
          {payByCard ? (
            <>{t(fulfillment === "Delivery" && scheduled ? "cart.payAndSchedule" : "cart.payAndPlace", { amount: formatCents(cardChargeCents) })}</>
          ) : (
            <>
              {fulfillment === "Pickup" ? t("cart.placePickup") : scheduled ? t("cart.schedule") : t("cart.place")} ·{" "}
              {fulfillment === "Pickup" ? formatCents(orderTotalCents) : t("cart.upTo", { amount: formatCents(estimatedTotalCents) })}
            </>
          )}
        </Button>
      </div>

      {payingCents !== null && payIssuer && agentPubKey && (
        <CardPaySheet
          issuer={payIssuer}
          agent={agentPubKey}
          amount={payingCents}
          title={t("cart.pay", { amount: formatCents(payingCents) })}
          subtitle={payingCents > shortfallCents ? t("cart.payShortMinimum", { minimum: formatCents(MIN_CARD_PAYMENT_CENTS) }) : t("cart.payShort")}
          onClose={() => setPayingCents(null)}
          onPaid={async () => {
            setPayingCents(null);
            await placeOrder();
          }}
        />
      )}

      {editing && cart.catalogRef && (
        <ItemSheet
          key={editing.key}
          catalogRef={cart.catalogRef}
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
