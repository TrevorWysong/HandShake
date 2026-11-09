import { FINISHED_SHOWN_MICROS, useActiveOrders, type ActiveOrder, type FinishedOrder } from "../../store/activeOrders";
import { customerOrderPath } from "../orders/orderEntries";
import { customerProgress, type OrderTone } from "../orders/progress";
import { useClock } from "./useClock";

/// What leads: what needs them, then what just finished, then the oldest going.
const ORDER: Record<OrderTone, number> = { needsYou: 0, arrived: 1, stopped: 2, moving: 3, quiet: 4 };

export interface CardOrder {
  order: ActiveOrder;
  finished: boolean;
}

/// The orders the card shows, on the screen at `pathname`: those not yet just
/// waiting for their date, those just finished for a little while, and never
/// the one whose own page is open.
export function useCardOrders(pathname: string, owner: string | null): CardOrder[] {
  const state = useActiveOrders();
  const now = useClock();
  // The Orders tab is the list itself.
  if (state.owner !== owner || pathname === "/customer/orders") return [];
  const nowAt = now.getTime() * 1000;
  const here = (o: ActiveOrder) => pathname === customerOrderPath(o.row);
  const fresh = (o: FinishedOrder) => nowAt - o.finishedAt < FINISHED_SHOWN_MICROS;
  const cards: CardOrder[] = [
    ...(state.orders ?? []).filter((o) => o.row.order.status !== "Scheduled" && !here(o)).map((order) => ({ order, finished: false })),
    ...state.finished.filter((o) => fresh(o) && !here(o)).map((order) => ({ order, finished: true })),
  ];
  return cards.sort((a, b) => ORDER[customerProgress(a.order.row, a.order.need).tone] - ORDER[customerProgress(b.order.row, b.order.need).tone]);
}

/// The screens with a bar of their own at the bottom, where nothing else fits.
const OWN_BAR = [/^\/customer\/cart\/[^/]+$/, /^\/rewards\/[^/]+\/redeem$/];

export function dockFits(pathname: string): boolean {
  return !OWN_BAR.some((screen) => screen.test(pathname));
}
