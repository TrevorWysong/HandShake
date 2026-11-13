// Everyone sees their own record, in the words others see it in
// (docs/REPUTATION.md, "Seen by its subject"): a customer on their profile,
// a store on its page. Needs the seeded dev network.
import { expect, test } from "@playwright/test";
import { signInAs } from "./seed.ts";

test("a customer sees their own record on their profile, as stores and drivers do", async ({ page }) => {
  await signInAs(page, "sam");
  await page.goto("/#/profile");
  await expect(page.getByRole("heading", { name: "Your record" })).toBeVisible();
  await expect(page.getByText("Stores and drivers see exactly this when they take your order.")).toBeVisible();
  await page.getByRole("button", { name: "How your record works" }).click();
  await expect(page.getByRole("dialog").getByText("If something looks wrong")).toBeVisible();
});

test("a store sees its own record on its page, as customers and drivers do", async ({ page }) => {
  await signInAs(page, "cara");
  await page.goto("/#/merchant/store");
  await expect(page.getByRole("heading", { name: "Your store's record" })).toBeVisible();
  await expect(page.getByText("Customers see this on your store's page, and drivers on each of your orders.")).toBeVisible();
});
