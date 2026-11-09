// Paying directly, in the app: a customer's card held by the store before
// it accepts, a store connecting where it's paid, a driver's collateral and
// pay held, and the records afterwards. Needs the seeded
// dev network and its payment agents (`npm run dev:payments`), all on the
// test processor. With SCREENSHOTS=<dir>, each screen is also kept at phone,
// tablet and desktop sizes, for review.
import { expect, test, type Page } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

const SIZES = [
  { name: "phone", width: 412, height: 915 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
];

/// The screen as it is, at each size -- only when asked for.
async function shoot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  const original = page.viewportSize();
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    // Past the route's transition, and the processor's form drawn.
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}-${size.name}.png`, fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

test("a customer's card is held by the store before it takes the order", async ({ page, browser }) => {
  const tacos = store("tacos");
  await signInAs(page, "ana");
  await page.locator("main").getByText(tacos.name, { exact: true }).first().click();
  await page.getByRole("button", { name: `Add ${tacos.menu[0].name}` }).click();
  await page.getByRole("link", { name: "Cart" }).click();
  await page.getByText("Pickup", { exact: true }).click();
  await page.getByRole("button", { name: /Place pickup order/ }).click();
  const hold = page.getByRole("button", { name: /^Hold .* on my card$/ });
  await expect(hold).toBeEnabled();
  await shoot(page, "pay-sheet");
  await hold.click();
  await expect(page.getByText(/Waiting for the store to accept your order/)).toBeVisible();
  await shoot(page, "order-confirming-payment");

  // The store's agent holds the card; then the store can take the order.
  const storeSide = await (await browser.newContext()).newPage();
  await signInAs(storeSide, "mo");
  await storeSide.getByRole("button", { name: "Sell" }).click();
  await expect(storeSide.getByRole("button", { name: /^Accept · \d+ min$/ }).first()).toBeVisible();
  await shoot(storeSide, "store-orders");
});

test("a store sees where it's paid, and connects again", async ({ page }) => {
  await signInAs(page, "cara");
  await page.goto("/#/payments");
  await expect(page.getByText(/Paid into your Test account/)).toBeVisible();
  await shoot(page, "payments-connected");
  // Disconnecting asks first: collecting what's held stops with it.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText(/collect what's already held/)).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("radio", { name: /Stripe/ })).toBeVisible();
  await page.getByRole("radio", { name: /Stripe/ }).click();
  await shoot(page, "payments-connect-stripe");
  await page.getByRole("radio", { name: /Square/ }).click();
  await shoot(page, "payments-connect-square");
  await page.getByRole("radio", { name: /Clover/ }).click();
  await shoot(page, "payments-connect-clover");
  await page.getByRole("radio", { name: /Test processor/ }).click();
  await page.getByRole("button", { name: "Use the test processor" }).click();
  await expect(page.getByText(/Paid into your Test account/)).toBeVisible();
});

test("a driver's collateral and pay are held -- by themselves, once cards are kept with each other", async ({ page }) => {
  // Dana and Mo's stores kept their cards with each other on earlier
  // orders: a bid accepted, both apps pay at once, and Dana is committed.
  await signInAs(page, "dana");
  await page.goto("/#/driver");
  await expect(page.getByText(/held on your card by the store/).first()).toBeVisible();
  await expect(page.getByText("Your pay is held on the store's card.").first()).toBeVisible();
  await shoot(page, "driver-active");
});

test("everyone's record of what they paid and were paid", async ({ page, browser }) => {
  await signInAs(page, "dana");
  await page.goto("/#/driver/earnings");
  await expect(page.getByText("Getting paid")).toBeVisible();
  await shoot(page, "driver-earnings");
  const customer = await (await browser.newContext()).newPage();
  await signInAs(customer, "sam");
  await customer.goto("/#/transparency");
  await expect(customer.getByText("Every payment, newest first")).toBeVisible();
  await shoot(customer, "transparency");
  await customer.goto("/#/payments");
  await expect(customer.getByText("Your payments")).toBeVisible();
  await expect(customer.getByText("Getting paid")).toHaveCount(0);
  await shoot(customer, "payments-customer");
});
