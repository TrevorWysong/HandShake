// A recurring order asks, and never orders: at its time its customer is
// reminded with the order ready at checkout, and it's placed only when they
// pay. The rules themselves are proved in tests/tryorama/src/recurring-orders.
import { expect, test } from "@playwright/test";
import { signInAs, store } from "./seed.ts";

test("a recurring order reminds its customer, who confirms and pays at checkout", async ({ page }) => {
  // It comes due a couple of minutes after it's set up.
  test.setTimeout(300_000);
  const tacos = store("tacos");
  await signInAs(page, "ana");
  await page.locator("main").getByText(tacos.name, { exact: true }).first().click();
  await page.getByRole("button", { name: `Add ${tacos.menu[0].name}` }).click();
  await page.getByRole("link", { name: "Cart" }).click();
  await page.getByRole("button", { name: "Set up" }).click();
  const due = new Date(Date.now() + 120_000);
  await page.getByRole("button", { name: "Daily" }).click();
  await page.locator('input[type="time"]').fill(`${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`);
  await page.getByRole("button", { name: "Save recurring order" }).click();
  await expect(page.getByText(/Saved!/)).toBeVisible();

  await page.goto("/#/customer/orders");
  const review = page.getByRole("button", { name: "Review and pay" });
  await expect(review).toBeVisible({ timeout: 240_000 });

  // Checkout, ready to pay -- with no offer to keep the card, or set it up again.
  await review.click();
  await expect(page.getByText(tacos.menu[0].name)).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Place order/ }).click();
  await expect(page.getByRole("switch")).toHaveCount(0);
  await page.getByRole("button", { name: /^Hold .* on my card$/ }).click();
  await expect(page).toHaveURL(/customer\/orders\/./);

  // Answered, it asks no more until its next time.
  await page.goto("/#/customer/orders");
  await expect(page.getByText(tacos.name).first()).toBeVisible();
  await expect(review).toHaveCount(0);
});
