// Narrowing the stores near a customer, with pills that say what each choice
// leaves, and that are still there coming back from a store.
import { expect, test } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

async function keep(page: import("@playwright/test").Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png` });
}

test("filters narrow the list, say what they leave, and survive going into a store", async ({ page }) => {
  await signInAs(page, "ana");
  const main = page.locator("main");
  const kitchen = main.getByText(store("kitchen").name, { exact: true }).first();
  await expect(kitchen).toBeVisible();
  await keep(page, "filters-home");

  // Deals: Mo's Kitchen has an item on sale and Cara's a goodie bag; Mo's Tacos neither.
  const tacos = main.getByText(store("tacos").name, { exact: true });
  await expect(tacos.first()).toBeVisible();
  await page.getByRole("button", { name: "Deals" }).click();
  await expect(tacos).toHaveCount(0);
  await expect(kitchen).toBeVisible();
  await keep(page, "filters-deals");
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(tacos.first()).toBeVisible();

  await page.getByRole("button", { name: "Rating" }).click();
  const tiles = page.getByRole("dialog", { name: "Minimum rating" }).getByRole("radio");
  await expect(tiles).toHaveCount(4);
  await keep(page, "filters-rating");
  await tiles.last().click();
  await expect(page.getByRole("button", { name: "4.5+" })).toBeVisible();
  await expect(page).toHaveURL(/rating=4\.5/);

  await page.getByRole("button", { name: "Open now" }).click();
  await expect(page).toHaveURL(/open=1/);
  await page.reload();
  await expect(page.getByRole("button", { name: "4.5+" })).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/rating|open=/);

  await page.getByRole("button", { name: "Sort" }).click();
  await page.getByRole("dialog", { name: "Sort by" }).getByRole("radio", { name: "Nearest" }).click();
  await kitchen.click();
  await expect(page).toHaveURL(/merchant\//);
  await page.goBack();
  await expect(page.getByRole("button", { name: "Nearest" })).toBeVisible();
});
