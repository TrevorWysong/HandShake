// Appearance, among the account's settings as the big apps keep it: the
// device's theme by default, or always light or dark -- kept on this device
// through a reload. With SCREENSHOTS=<dir>, both themes are kept.
import { expect, test } from "@playwright/test";
import { signInAs } from "./seed.ts";

test("light or dark, as chosen in Appearance, and kept", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signInAs(page, "lee");
  await page.goto("/#/profile");
  const html = page.locator("html");
  const appearance = page.getByRole("radiogroup", { name: "Appearance" });
  await expect(appearance.getByRole("radio", { name: "Device" })).toHaveAttribute("aria-checked", "true");
  await expect(html).toHaveClass(/\blight\b/);

  // The device's theme, followed as it changes.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/\bdark\b/);

  // Always light, whatever the device -- and always dark.
  await appearance.getByRole("radio", { name: "Light" }).click();
  await expect(html).toHaveClass(/\blight\b/);
  await appearance.getByRole("radio", { name: "Dark" }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveClass(/\bdark\b/);
  await appearance.scrollIntoViewIfNeeded();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/appearance-dark.png` });

  // Kept through a reload.
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  await page.getByRole("radiogroup", { name: "Appearance" }).getByRole("radio", { name: "Light" }).click();
  await page.getByRole("radiogroup", { name: "Appearance" }).scrollIntoViewIfNeeded();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/appearance-light.png` });
  await page.getByRole("radiogroup", { name: "Appearance" }).getByRole("radio", { name: "Device" }).click();
});
