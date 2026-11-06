// A sale reads on the menu, in its sheet and in the cart, and a store sets one.
// What's refused is proved in tests/tryorama/src/sale-prices.
import { expect, test, type Page } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

async function keep(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png`, fullPage: true });
}

test("a sale shows its price crossed out, and the cart charges the sale's", async ({ page }) => {
  await signInAs(page, "ana");
  await page.locator("main").getByText(store("kitchen").name, { exact: true }).first().click();
  const onSale = page.locator("#menu-sale");
  await expect(onSale.getByRole("heading", { name: "On sale" })).toBeVisible();
  await expect(onSale.getByText("Early bird")).toBeVisible();
  await expect(onSale.getByText("$9.50")).toBeVisible();
  await expect(onSale.getByText("26% off")).toBeVisible();
  await keep(page, "sale-menu");
  await onSale.getByRole("button", { name: "Add Pancake Stack" }).click();
  await page.getByRole("link", { name: "Cart" }).click();
  await expect(page.getByText("$7.00").first()).toBeVisible();
  await keep(page, "sale-cart");
});

test("a store puts an item on sale, on a schedule", async ({ page }) => {
  await signInAs(page, "cara");
  await page.goto("/#/merchant/menu");
  await page.locator('button[aria-label]').filter({ has: page.locator("svg.lucide-pencil") }).first().click();
  // Whatever an earlier run left: the seeded world carries on between runs.
  const turnOn = async (name: string) => {
    const on = page.getByRole("switch", { name });
    if (!(await on.isChecked())) await on.click();
  };
  await turnOn("On sale");
  await page.getByRole("button", { name: "20% off" }).click();
  await turnOn("Only on certain days and times");
  const monday = page.getByRole("group", { name: "Days" }).getByRole("button", { name: "Mon" });
  if ((await monday.getAttribute("aria-pressed")) !== "true") await monday.click();
  await keep(page, "sale-editor");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/On sale: /).first()).toBeVisible();
});
