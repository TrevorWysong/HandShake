// A store giving a customer points on a finished order -- a thank-you, or an
// apology no report covers -- from its own rewards program. Needs the
// seeded dev network. What's refused is proved in tests/tryorama.
import { expect, test } from "@playwright/test";
import { signInAs } from "./seed.ts";

test("a store gives points on a finished order, from its program's own rewards", async ({ page }) => {
  await signInAs(page, "cara");
  await page.goto("/#/merchant");
  await page.getByRole("tab", { name: "History" }).click();
  await page.getByRole("button", { name: "Give points" }).first().click();

  // Amounts its rewards cost, at a tap -- always points, with what they're
  // enough for said plainly; the button says what goes.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Given in Café Club", { exact: false })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "450 beans", exact: true }).click();
  await expect(dialog.getByText("They get 450 beans: enough for “Free Latte”", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Give 450 beans" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Gave 450 beans" })).toBeVisible({ timeout: 30_000 });
});
