// The terms come before anything else, and can't be skipped.
import { expect, test } from "@playwright/test";

test("a new device agrees to the terms before anything else, and isn't asked again", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Terms of use" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Draft");
  const proceed = page.getByRole("button", { name: "Agree and continue" });
  await expect(proceed).toBeDisabled();
  await page.getByRole("checkbox").check();
  await proceed.click();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of use" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Agree and continue" })).toHaveCount(0);
});
