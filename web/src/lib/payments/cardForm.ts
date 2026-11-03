// A payee's card form, whatever their processor: each processor's own
// form, in its own frames, loaded only from that processor's own domain --
// card details never touch HandShake (PCI SAQ A). What it gives back is a
// single-use token only the payee can use, which the app seals to them
// (`offerPayment`); the payee's payment agent turns it into a hold.
//
// | Processor | Form | Token | Challenge (3-D Secure) |
// |---|---|---|---|
// | Stripe | Payment Element, cards only | a PaymentMethod id | `handleNextAction` on the intent's client secret |
// | Square | Web Payments SDK card | a nonce, with the buyer's verification | done before tokenizing (`verifyBuyer`) |
// | Clover | its iframe card fields | a card token | none |
// | Test | a plain field (test networks only) | `tok_test_...` | none |
import { loadStripe, type Stripe, type StripeElements } from "@stripe/stripe-js";
import type { PaymentProfile } from "../../holochain/types";
import { t } from "../../i18n";

export interface CardForm {
  /// Shows the form in `element`.
  mount(element: HTMLElement): Promise<void>;
  /// The single-use token for the card entered -- or throws, in words for
  /// the person.
  tokenize(): Promise<string>;
  /// Completes what the payee's processor asked of the card before it
  /// would hold it (`PaymentStanding::ActionNeeded`).
  complete(challenge: string): Promise<void>;
  destroy(): void;
}

/// What the form is for: the amount, in minor units of `currency`.
export interface Charge {
  amountCents: number;
  currency: string;
}

/// The card form for `profile`'s processor.
export function cardFormFor(profile: PaymentProfile, charge: Charge): CardForm {
  switch (profile.processor) {
    case "Stripe":
      return stripeForm(profile, charge);
    case "Square":
      return squareForm(profile, charge);
    case "Clover":
      return cloverForm(profile);
    case "Test":
      return testForm();
  }
}

/// A problem with the card, as the person reads it.
class CardProblem extends Error {}

// --- Stripe ---

function stripeForm(profile: PaymentProfile, charge: Charge): CardForm {
  let stripe: Stripe | null = null;
  let elements: StripeElements | null = null;
  return {
    async mount(element) {
      stripe = await loadStripe(profile.public_key);
      if (!stripe) throw new CardProblem(t("pay.formUnavailable"));
      // A card authorized now and captured later: cards only, the amount
      // the payee will hold.
      elements = stripe.elements({ mode: "payment", amount: charge.amountCents, currency: charge.currency.toLowerCase(), captureMethod: "manual", paymentMethodCreation: "manual", paymentMethodTypes: ["card"] });
      elements.create("payment", { layout: "tabs" }).mount(element);
    },
    async tokenize() {
      if (!stripe || !elements) throw new CardProblem(t("pay.formUnavailable"));
      const submitted = await elements.submit();
      if (submitted.error) throw new CardProblem(submitted.error.message ?? t("pay.cardProblem"));
      const created = await stripe.createPaymentMethod({ elements });
      if (created.error || !created.paymentMethod) throw new CardProblem(created.error?.message ?? t("pay.cardProblem"));
      return created.paymentMethod.id;
    },
    async complete(challenge) {
      if (!stripe) stripe = await loadStripe(profile.public_key);
      if (!stripe) throw new CardProblem(t("pay.formUnavailable"));
      const result = await stripe.handleNextAction({ clientSecret: challenge });
      if (result.error) throw new CardProblem(result.error.message ?? t("pay.actionFailed"));
    },
    destroy() {
      elements?.getElement("payment")?.destroy();
    },
  };
}

// --- Square ---

interface SquareCard {
  attach(element: HTMLElement): Promise<void>;
  tokenize(): Promise<{ status: string; token?: string; errors?: { message: string }[] }>;
  destroy(): Promise<void>;
}
interface SquarePayments {
  card(): Promise<SquareCard>;
  verifyBuyer(token: string, details: { amount: string; currencyCode: string; intent: "CHARGE"; billingContact: Record<string, never> }): Promise<{ token?: string }>;
}
declare global {
  interface Window {
    Square?: { payments(applicationId: string, locationId: string): SquarePayments };
    Clover?: new (publicKey: string, options: { merchantId: string }) => CloverClient;
  }
}

/// Loads a processor's own script, once, from its own domain.
const loaded = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  let loading = loaded.get(src);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        loaded.delete(src);
        reject(new CardProblem(t("pay.formUnavailable")));
      };
      document.head.appendChild(script);
    });
    loaded.set(src, loading);
  }
  return loading;
}

function squareForm(profile: PaymentProfile, charge: Charge): CardForm {
  let payments: SquarePayments | null = null;
  let card: SquareCard | null = null;
  return {
    async mount(element) {
      await loadScript(profile.live ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js");
      if (!window.Square) throw new CardProblem(t("pay.formUnavailable"));
      payments = window.Square.payments(profile.public_key, profile.account);
      card = await payments.card();
      await card.attach(element);
    },
    async tokenize() {
      if (!payments || !card) throw new CardProblem(t("pay.formUnavailable"));
      const result = await card.tokenize();
      if (result.status !== "OK" || !result.token) throw new CardProblem(result.errors?.[0]?.message ?? t("pay.cardProblem"));
      // Strong customer authentication happens here, before the payee's
      // agent ever sees the card.
      const verified = await payments.verifyBuyer(result.token, { amount: (charge.amountCents / 100).toFixed(2), currencyCode: charge.currency, intent: "CHARGE", billingContact: {} });
      return JSON.stringify({ nonce: result.token, verification: verified.token ?? null });
    },
    async complete() {
      throw new CardProblem(t("pay.actionFailed"));
    },
    destroy() {
      void card?.destroy();
    },
  };
}

// --- Clover ---

interface CloverElement {
  mount(selector: string | HTMLElement): void;
}
interface CloverClient {
  elements(): { create(kind: string): CloverElement };
  createToken(): Promise<{ token?: string; errors?: Record<string, string> }>;
}

function cloverForm(profile: PaymentProfile): CardForm {
  let clover: CloverClient | null = null;
  return {
    async mount(element) {
      await loadScript(profile.live ? "https://checkout.clover.com/sdk.js" : "https://checkout.sandbox.dev.clover.com/sdk.js");
      if (!window.Clover) throw new CardProblem(t("pay.formUnavailable"));
      clover = new window.Clover(profile.public_key, { merchantId: profile.account });
      const elements = clover.elements();
      // Clover's fields each have their own frame.
      for (const kind of ["CARD_NUMBER", "CARD_DATE", "CARD_CVV", "CARD_POSTAL_CODE"]) {
        const slot = document.createElement("div");
        slot.className = "mb-2 h-10 rounded-xl border border-ink-200 px-3 dark:border-ink-700";
        element.appendChild(slot);
        elements.create(kind).mount(slot);
      }
    },
    async tokenize() {
      if (!clover) throw new CardProblem(t("pay.formUnavailable"));
      const result = await clover.createToken();
      if (!result.token) throw new CardProblem(Object.values(result.errors ?? {})[0] ?? t("pay.cardProblem"));
      return result.token;
    },
    async complete() {
      throw new CardProblem(t("pay.actionFailed"));
    },
    destroy() {},
  };
}

// --- Test ---

/// A stand-in card form on test networks: a field taking a test card's
/// last four digits, `4242` for one that works.
function testForm(): CardForm {
  let input: HTMLInputElement | null = null;
  return {
    async mount(element) {
      input = document.createElement("input");
      input.inputMode = "numeric";
      input.maxLength = 4;
      input.value = "4242";
      input.setAttribute("aria-label", t("pay.testCard"));
      input.className = "w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-sm dark:border-ink-700 dark:bg-ink-900";
      element.appendChild(input);
    },
    async tokenize() {
      const digits = input?.value.trim() ?? "";
      if (!/^\d{4}$/.test(digits)) throw new CardProblem(t("pay.cardProblem"));
      return `tok_test_${digits}`;
    },
    async complete() {},
    destroy() {
      input?.remove();
    },
  };
}
