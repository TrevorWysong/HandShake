// Who and what `npm run seed` creates, from the same data the seed script
// plays (scripts/lib/world.ts), so the tests can't drift from it.
import { TERMS_VERSION } from "../src/lib/policies/termsVersion.ts";
import { WORLD } from "../scripts/lib/world.ts";
import { expect, type Page } from "@playwright/test";

interface Person {
  slug: string;
  name: string;
  roles: string[];
}
interface Store {
  key: string;
  owner: string;
  name: string;
  details: { phone?: string };
  menu: { name: string }[];
  promos?: { code: string }[];
}

export const SEED_PEOPLE: (Person & { appId: string })[] = (WORLD.people as Person[]).map((person) => ({
  ...person,
  // Mirrors seed.ts's app id for a person.
  appId: `seed-${person.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
}));
export const SEED_STORES = WORLD.stores as Store[];

export function person(slug: string) {
  const found = SEED_PEOPLE.find((p) => p.slug === slug);
  if (!found) throw new Error(`No seeded person "${slug}"`);
  return found;
}

export function store(key: string) {
  const found = SEED_STORES.find((s) => s.key === key);
  if (!found) throw new Error(`No seeded store "${key}"`);
  return found;
}

/// Signs in as a seeded person through the onboarding screen's dev
/// identity picker -- the same path a developer clicks through.
export async function signInAs(page: Page, slug: string) {
  const { name } = person(slug);
  await acceptTerms(page);
  // The app routes by hash (`/#/onboarding`).
  await page.goto("/#/onboarding");
  await page.getByRole("button", { name: /Use an existing identity on this node/ }).click();
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  // Home, and settled: it redirects there, and would undo a test's own navigation.
  await expect(page).toHaveURL(/#\/(customer|driver|merchant)$/);
}

/// Has this browser already agreed to the terms: only `terms.spec` walks that.
export async function acceptTerms(page: Page) {
  await page.addInitScript(([key, version]) => localStorage.setItem(key, JSON.stringify({ state: { acceptedVersion: version }, version: 0 })), ["handshake.terms.v1", TERMS_VERSION]);
}
