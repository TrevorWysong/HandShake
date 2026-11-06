// Sale prices: whether one's running, what a line sells at, and how it reads.
// The network's own rules (`catalog_types::ItemSale`, `stores::sale_running`),
// so what's shown is what an order's priced at.
import type { ItemSale, MerchantCatalog } from "../../holochain/types";
import { MAX_LABEL_CHARS } from "../../holochain/types";
import { t } from "../../i18n";
import { formatCents, formatDeadline, formatTimeOfDay } from "../ui/format";
import type { ItemRow } from "./menu";
import { closesAt, describeWeek, localWeekdayMinute, openAt } from "./storeHours";

type StoreClock = Pick<MerchantCatalog, "time_zone">;

export function saleRunning(sale: ItemSale, store: StoreClock, at: Date): boolean {
  const micros = at.getTime() * 1000;
  if (sale.starts_at !== null && micros < sale.starts_at) return false;
  if (sale.ends_at !== null && micros >= sale.ends_at) return false;
  const { weekday, minute } = localWeekdayMinute(store.time_zone, at);
  return openAt(sale.weekly, weekday, minute);
}

/// An item as it sells right now, with what it's reduced from if it's on sale.
export function soldRow(row: ItemRow, store: StoreClock, at: Date): ItemRow {
  const { sale } = row.item;
  if (!sale || !saleRunning(sale, store, at)) return row;
  return { ...row, fullPriceCents: row.item.price_cents, item: { ...row.item, price_cents: sale.price_cents } };
}

/// What it comes off by, as a customer reads it.
export function saleOff(fullCents: number, saleCents: number): string {
  const percent = Math.round((1 - saleCents / fullCents) * 100);
  return percent >= 5 ? t("sale.percentOff", { percent }) : t("sale.amountOff", { amount: formatCents(fullCents - saleCents) });
}

/// When a sale running at `at` stops, in words -- none if it isn't soon to say.
export function saleUntil(sale: ItemSale, store: StoreClock, at: Date): string | null {
  if (sale.weekly.length > 0) {
    const { weekday, minute } = localWeekdayMinute(store.time_zone, at);
    const closes = closesAt(sale.weekly, weekday, minute);
    if (closes) return t("sale.until", { time: formatTimeOfDay(closes.minute) });
  }
  return sale.ends_at !== null ? t("sale.until", { time: formatDeadline(sale.ends_at) }) : null;
}

/// When a sale runs, for one that isn't running now.
export function saleSchedule(sale: ItemSale, at: Date): string | null {
  if (sale.ends_at !== null && at.getTime() * 1000 >= sale.ends_at) return null;
  const week = describeWeek(sale.weekly).map(({ days, hours }) => `${days} ${hours}`).join(", ");
  if (week) return t("sale.runs", { when: week });
  return sale.starts_at !== null ? t("sale.starts", { when: formatDeadline(sale.starts_at) }) : null;
}

/// What the network would refuse about a sale on an item at `fullCents`.
export function saleProblem(sale: ItemSale, fullCents: number): string | null {
  if (sale.price_cents <= 0 || sale.price_cents >= fullCents) return t("sale.problem.price");
  if (sale.label.length > MAX_LABEL_CHARS) return t("sale.problem.label");
  if (sale.starts_at !== null && sale.ends_at !== null && sale.starts_at >= sale.ends_at) return t("sale.problem.dates");
  return null;
}

/// A cart line at today's price: a sale can start or stop while it waits there.
export function repricedLine<L extends { itemRef: Uint8Array; basePriceCents: number; priceCents: number }>(line: L, base: number): L {
  return line.basePriceCents === base ? line : { ...line, basePriceCents: base, priceCents: line.priceCents - line.basePriceCents + base };
}

