// Allergies from both ends: a store says what it can, a customer's own list is
// flagged on its menu and told to it at checkout, and the store reads it on the
// ticket. What's refused, and who can read what, is proved in
// tests/tryorama/src/allergens.
import { expect, test, type Page } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

async function keep(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png`, fullPage: true });
}

/// Says whether they're allergic to one thing, whatever an earlier run left.
async function setAllergy(page: Page, allergen: string, allergic: boolean) {
  await page.goto("/#/profile");
  const chip = page.getByRole("group", { name: "Your allergies" }).getByRole("button", { name: allergen, exact: false });
  await expect(chip).toBeVisible();
  if ((await chip.getAttribute("aria-pressed")) === String(allergic)) return;
  await chip.click();
  await page.getByRole("button", { name: "Save allergies" }).click();
  await expect(page.getByRole("button", { name: "Save allergies" })).toHaveCount(0);
}

// Each test takes its customer's allergy off again, passed or failed: the
// seeded world carries on between tests, and one left set would open every
// later test's items to an allergy check.
let cleanup: (() => Promise<void>) | null = null;
test.afterEach(async () => {
  await cleanup?.().catch(() => undefined);
  cleanup = null;
});

test("a customer's allergies are flagged on a menu, and it's their call what's shown", async ({ page }) => {
  const kitchen = store("kitchen");
  await signInAs(page, "sam");
  await setAllergy(page, "Milk", true);
  cleanup = () => setAllergy(page, "Milk", false);
  await keep(page, "allergies-profile");

  await page.goto("/#/customer");
  await page.locator("main").getByText(kitchen.name, { exact: true }).first().click();
  await expect(page.getByText("Flagging: Milk")).toBeVisible();
  await expect(page.getByText("Contains your allergens: Milk")).toBeVisible();
  // Unsaid is never safe.
  await expect(page.getByText("The store hasn't said what's in this. Ask before you order.").first()).toBeVisible();
  await keep(page, "allergies-menu");

  // Something flagged is looked at before it's in the cart.
  await page.getByRole("button", { name: "Add Smash Burger" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Milk");
  await keep(page, "allergies-item");
  await page.getByRole("dialog").getByRole("button", { name: /Close/ }).click();

  // Hiding what contains them leaves what hasn't said, still flagged.
  await page.getByRole("button", { name: "Hide what contains them" }).click();
  await expect(page.getByRole("button", { name: "Add Smash Burger" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add Pancake Stack" }).first()).toBeVisible();
});

test("a store sets how it takes allergies, a customer's reach it, and it reads them on the ticket", async ({ page, browser }) => {
  const kitchen = store("kitchen");
  const storeSide = await (await browser.newContext()).newPage();
  await signInAs(storeSide, "mo");
  await storeSide.getByRole("button", { name: "Sell" }).click();
  await storeSide.goto("/#/merchant/store");
  await expect(storeSide.getByRole("heading", { level: 1, name: kitchen.name })).toBeVisible();
  // Whatever an earlier run left: the seeded world carries on between runs.
  const stated = storeSide.getByRole("switch", { name: "Allergies" });
  await expect(stated).toBeVisible();
  if (!(await stated.isChecked())) await stated.click();
  const sesame = storeSide.getByRole("group", { name: "Handled somewhere in the kitchen" }).getByRole("button", { name: "Sesame" });
  if ((await sesame.getAttribute("aria-pressed")) !== "true") await sesame.click();
  await keep(storeSide, "allergies-store-policy");
  await storeSide.getByRole("button", { name: "Save allergy settings" }).click();
  await expect(storeSide.getByRole("switch", { name: "Allergies" })).toBeChecked();

  await signInAs(page, "ana");
  await setAllergy(page, "Sesame", true);
  cleanup = () => setAllergy(page, "Sesame", false);
  await page.goto("/#/customer");
  await page.locator("main").getByText(kitchen.name, { exact: true }).first().click();
  await expect(page.getByText("Flagging: Sesame")).toBeVisible();
  // Its fries have none in them, by its word, but its kitchen handles sesame.
  await page.getByRole("button", { name: "Add Hand-cut Fries" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Add to cart/ }).click();
  await page.getByRole("link", { name: "Cart" }).click();
  await page.getByText("Pickup", { exact: true }).click();

  // Told to the store unless they say otherwise, with what the store said.
  await expect(page.getByRole("switch", { name: /^Tell / })).toBeChecked();
  await expect(page.getByText(/A person there reads it before accepting/)).toBeVisible();
  await expect(page.getByText("May contain your allergens: Sesame")).toBeVisible();
  await keep(page, "allergies-cart");

  await page.getByRole("button", { name: /Place pickup order/ }).click();
  await page.getByRole("button", { name: /^Hold .* on my card$/ }).click();
  await expect(page.getByText("You told the store")).toBeVisible();
  await keep(page, "allergies-order");

  await storeSide.goto("/#/merchant");
  await expect(storeSide.getByText("Allergies: read before accepting").first()).toBeVisible({ timeout: 60_000 });
  await keep(storeSide, "allergies-ticket");
});
