// A cart per store, as the big apps keep them: adding from a second store
// starts its own cart and leaves the first as it was; the Cart tab lists
// them, each checked out on its own; one removed, the other is the cart.
// With SCREENSHOTS=<dir>, the list is also kept at phone and desktop sizes.
import { expect, test, type Page } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

/// Adds a store's first item from its page -- through its sheet if it has
/// choices to make.
async function addFirstItem(page: Page, key: string) {
  const { name, menu } = store(key);
  await page.goto("/#/customer");
  await page.locator("main").getByText(name, { exact: true }).first().click();
  await page.getByRole("button", { name: `Add ${menu[0].name}` }).click();
  // Choices to make: the first of a required one, then add it.
  const sheet = page.getByRole("dialog");
  if (await sheet.isVisible().catch(() => false)) {
    await sheet.getByRole("radio").first().click();
    await sheet.getByRole("button", { name: /^Add to cart · / }).click();
  }
  await expect(page.getByRole("button", { name: /View cart/ }).or(page.getByRole("button", { name: "Checkout" })).first()).toBeVisible();
}

test("each store keeps its own cart, listed together and checked out apart", async ({ page }) => {
  const [tacos, cafe] = [store("tacos"), store("cafe")];
  await signInAs(page, "rio");
  await addFirstItem(page, "tacos");
  await addFirstItem(page, "cafe");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Both carts, listed, newest first.
  await page.getByRole("link", { name: "Cart" }).first().click();
  await expect(page.getByRole("heading", { name: "Carts" })).toBeVisible();
  const cards = page.locator("main").getByText(/^(Mo's Tacos|Cara's Café)$/);
  await expect(cards).toHaveText([cafe.name, tacos.name]);
  if (process.env.SCREENSHOTS) {
    for (const size of [{ name: "phone", width: 412, height: 915 }, { name: "desktop", width: 1440, height: 900 }]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/carts-${size.name}.png`, fullPage: true });
    }
  }

  // Each checks out on its own.
  await page.getByRole("link", { name: "View cart" }).last().click();
  await expect(page.getByText(`from ${tacos.name}`)).toBeVisible();
  await expect(page.getByText(tacos.menu[0].name).first()).toBeVisible();
  await expect(page.getByText(cafe.menu[0].name)).toHaveCount(0);

  // One removed, the other is simply the cart.
  await page.getByRole("link", { name: "Cart" }).first().click();
  await page.getByRole("button", { name: `Remove your ${tacos.name} cart` }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText(tacos.name, { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Cart" }).first().click();
  await expect(page.getByText(`from ${cafe.name}`)).toBeVisible();
});
