// A goodie bag goes in the cart like anything else, and checkout says --
// before anything's placed -- when it can't be had the way the order is
// set. The rules themselves are proved in tests/tryorama/src/goodie-bags.
import { expect, test } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

test("a goodie bag is added to the cart, and checkout steers a pickup-only bag to pickup", async ({ page }) => {
  const cafe = store("cafe");
  await signInAs(page, "ana");
  await page.getByText(cafe.name, { exact: true }).first().click();
  await page.getByRole("button", { name: /^Add$/ }).click();
  await expect(page.getByText("In cart")).toBeVisible();

  await page.goto("/#/customer/cart");
  await page.getByRole("button", { name: "Delivery", exact: true }).first().click();
  await expect(page.getByText("End-of-day pastry bag is pickup only")).toBeVisible();
  await expect(page.getByText("Sort out the goodie bag above to place your order.")).toBeVisible();

  await page.getByRole("button", { name: "Switch to pickup" }).click();
  await expect(page.getByText("End-of-day pastry bag is pickup only")).toHaveCount(0);
  await page.getByRole("button", { name: /Place pickup order/ }).click();
  await expect(page).toHaveURL(/#\/customer\/pickup-orders\//);
});
