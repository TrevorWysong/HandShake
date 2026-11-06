// A store's page: its name opens everything else about it, a page of its own,
// and coming back finds the menu where it was left.
import { expect, test, type Page } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

/// With SCREENSHOTS=<dir>, keeps the settled screen for review.
async function keep(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png`, fullPage: true });
}

test("a store's name opens its info, and going back keeps the menu's place", async ({ page }) => {
  const kitchen = store("kitchen");
  await signInAs(page, "sam");
  await page.locator("main").getByText(kitchen.name, { exact: true }).first().click();
  const item = page.getByText(kitchen.menu[0].name).first();
  await expect(item).toBeVisible();

  await page.evaluate("window.scrollTo(0, 240)");
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBeGreaterThan(100);
  const left = await page.evaluate<number>("window.scrollY");

  await page.getByRole("link", { name: `Reviews, hours and address for ${kitchen.name}` }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { level: 1, name: kitchen.name })).toBeVisible();
  await expect(page.getByText("Info & contact")).toBeVisible();
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBeLessThan(10);
  await keep(page, "store-info");

  await page.getByRole("button", { name: "Back" }).click();
  await expect(item).toBeVisible();
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(left);
  await keep(page, "store-menu");
});

test("a customer's order in progress follows them round the app, and opens from anywhere", async ({ page }) => {
  await signInAs(page, "sam");
  // Sam's seeded delivery is still waiting on a driver or its store.
  const card = page.locator('a[href*="/customer/orders/"]').first();
  await expect(card).toBeVisible();
  await keep(page, "active-card-browse");
  await page.getByRole("link", { name: "Rewards" }).click();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/customer\/orders\/[0-9a-f]+$/);
  // On its own page, its hero takes over from the card.
  await expect(page.getByRole("status").first()).toBeVisible();
  await keep(page, "order-hero");
  await page.getByRole("button", { name: "All steps" }).click();
  await expect(page.getByText("Order placed")).toBeVisible();
});
