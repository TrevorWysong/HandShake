// An online driver's feed looks where they are -- their device's location,
// kept on it -- not round the address they saved; refused it, the saved
// address stands in, and the dashboard says so.
import { expect, test } from "@playwright/test";
import { signInAs } from "./seed.ts";

test("an online driver's feed follows where they are, or says it's using their saved address", async ({ browser }) => {
  // Far from every seeded order: nothing's open there.
  const away = await browser.newContext({ geolocation: { latitude: 47.6062, longitude: -122.3321 }, permissions: ["geolocation"] });
  const page = await away.newPage();
  await signInAs(page, "dana");
  await page.getByRole("button", { name: "Go online" }).click();
  await expect(page.getByText(/^(No open orders nearby|No add-ons on your way)$/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Showing orders near your saved address/)).toHaveCount(0);
  await away.close();

  // No location to be had: their saved address, said.
  const refused = await browser.newContext({ permissions: [] });
  const second = await refused.newPage();
  await signInAs(second, "dana");
  await second.getByRole("button", { name: "Go online" }).click();
  await expect(second.getByText(/^(Nearby open orders|Add-ons on your way)$/)).toBeVisible();
  await expect(second.getByText(/Showing orders near your saved address/)).toBeVisible({ timeout: 30_000 });
  await refused.close();
});
