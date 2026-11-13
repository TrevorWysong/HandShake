// What a customer can't get or didn't get, as both sides see it: the store
// finds it under Issues, however it heard, and each answer reaches the customer
// in their own words. Needs the seeded dev network and its payment agents
// (`npm run dev:payments`). What's refused is proved in tests/tryorama.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

const DESKTOP = { width: 1440, height: 900 };

// Each walks an order through two people's apps, and a report reaches the store's list on its poll.
test.describe.configure({ timeout: 240_000 });

async function keep(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  for (const [size, viewport] of [["phone", { width: 412, height: 915 }], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}-${size}.png`, fullPage: true });
  }
  await page.setViewportSize(DESKTOP);
}

/// Rio's pickup at Mo's Tacos, accepted and ready, with both sides looking at it.
/// Rio is this file's alone: the network caps a customer's orders every few
/// minutes, and these place several.
async function readyPickup(browser: Browser) {
  const tacos = store("tacos");
  const customer = await (await browser.newContext({ viewport: DESKTOP })).newPage();
  await signInAs(customer, "rio");
  await customer.locator("main").getByText(tacos.name, { exact: true }).first().click();
  await customer.getByRole("button", { name: `Add ${tacos.menu[0].name}` }).click();
  await customer.getByRole("link", { name: "Cart" }).click();
  await customer.getByText("Pickup", { exact: true }).click();
  await customer.getByRole("button", { name: /Place pickup order/ }).click();
  await customer.getByRole("button", { name: /^Hold .* on my card$/ }).click();
  await expect(customer).toHaveURL(/pickup-orders\//);
  await expect(customer.getByText("Confirming your payment with the store…")).toHaveCount(0, { timeout: 45_000 });

  // The queue runs oldest first, and the seeded world carries on between runs.
  const seller = await (await browser.newContext({ viewport: DESKTOP })).newPage();
  await signInAs(seller, "mo");
  await seller.getByRole("button", { name: "Sell" }).click();
  await seller.getByRole("button", { name: /^Accept · \d+ min$/ }).last().click();
  await seller.getByRole("button", { name: "Mark ready for pickup" }).last().click();
  await expect(customer.getByText(/Your order is ready\. Pick it up by/)).toBeVisible({ timeout: 45_000 });
  return { customer, seller };
}

async function saysItCantBeGot(customer: Page) {
  await customer.getByRole("button", { name: "Problem at the store?" }).click();
  await expect(customer.getByText(/not being able to get here/)).toBeVisible();
  await expect(customer.getByRole("dialog").getByText(store("tacos").details.phone!)).toBeVisible();
  await keep(customer, "cant-get-sheet");
  await customer.getByRole("button", { name: "Tell the store" }).click();
  await expect(customer.getByRole("status").filter({ hasText: "Waiting on the store's answer" })).toBeVisible();
  await expect(customer.getByText(/never arrived/)).toHaveCount(0);
}

test("a customer who can't get their order: the store cancels, and they aren't charged", async ({ browser }) => {
  const { customer, seller } = await readyPickup(browser);
  await saysItCantBeGot(customer);
  await keep(customer, "cant-get-customer");

  const issues = seller.getByRole("tab", { name: /Issues/ });
  await expect(issues).toHaveText(/\d/, { timeout: 45_000 });
  await keep(seller, "issues-badge");
  await issues.click();
  await expect(seller).toHaveURL(/tab=issues/);
  const ticket = seller.getByText("The customer can't get their order").first();
  await expect(ticket).toBeVisible();
  await keep(seller, "issues-cant-get");
  await seller.getByRole("button", { name: "Cancel, don't charge" }).first().click();
  await expect(seller.getByText(/This can't be undone/)).toBeVisible();
  await seller.getByRole("button", { name: "Cancel, don't charge" }).first().click();

  await expect(customer.getByText("The store cancelled this order. Any hold on your card is released.").first()).toBeVisible({ timeout: 45_000 });
  await keep(customer, "cant-get-cancelled");
});

test("a store that says it's ready has the last word", async ({ browser }) => {
  const { customer, seller } = await readyPickup(browser);
  await saysItCantBeGot(customer);
  await seller.getByRole("tab", { name: /Issues/ }).click();
  await seller.getByRole("button", { name: "It's ready" }).last().click();
  await expect(customer.getByText(/The store says your order is ready\. Collect it by/)).toBeVisible({ timeout: 45_000 });
  await expect(customer.getByRole("button", { name: "Problem at the store?" })).toHaveCount(0);
  await expect(customer.getByText(store("tacos").details.phone!)).toBeVisible();
  await keep(customer, "cant-get-dismissed");
  await customer.getByRole("button", { name: "I picked this up" }).click();
  await expect(customer.getByText("Missing or wrong items?")).toBeVisible();
});

test("a report of a missing item waits under Issues until the store answers it", async ({ browser }) => {
  const { customer, seller } = await readyPickup(browser);
  await saysItCantBeGot(customer);
  await customer.getByRole("button", { name: "I got my order after all" }).click();

  await customer.getByRole("button", { name: "Report missing or wrong items" }).click();
  await customer.getByRole("button", { name: "More" }).first().click();
  await customer.getByRole("button", { name: /^Report · / }).click();
  await expect(customer.getByText("Your report is in")).toBeVisible();

  // Away from the orders, the navigation says so -- new orders first, when
  // there are any: theirs is the shorter clock.
  await seller.goto("/#/merchant/menu");
  await expect(seller.getByRole("link", { name: /waiting on your answer|waiting for you/ })).toBeVisible({ timeout: 90_000 });
  await keep(seller, "issues-banner");
  await seller.goto("/#/merchant");
  await seller.getByRole("tab", { name: /Issues/ }).click();
  await expect(seller).toHaveURL(/tab=issues/);
  // The store's list catches up with the report on its poll.
  await expect(seller.getByText("The customer reported a problem").first()).toBeVisible({ timeout: 90_000 });
  await expect(seller.getByText(/Refund all, part or none of each report by/).first()).toBeVisible();
  await keep(seller, "issues-report");

  // Refunded in part -- and whatever an earlier run left too: the seeded
  // world carries on between runs.
  const part = seller.getByRole("tab", { name: "Part" });
  const refund = seller.getByRole("button", { name: /^Refund / });
  await expect(async () => {
    if (await refund.count()) {
      if (await part.count()) await part.first().click();
      await refund.first().click();
    }
    await expect(seller.getByRole("tab", { name: /Issues/ })).toHaveText("Issues", { timeout: 4_000 });
  }).toPass({ timeout: 60_000 });
  await expect(seller.getByText("No open issues")).toBeVisible();
  await keep(seller, "issues-empty");
});
