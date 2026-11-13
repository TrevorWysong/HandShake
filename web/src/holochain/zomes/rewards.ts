import { callZome } from "../client";
import type { ActionHash, AgentPubKey, CardView, OrderPoints, ProgramStats, ProgramView, RewardsProgram } from "../types";

/// A store's rewards program at its current version -- `null` if it has none.
export async function programOf(catalogRef: ActionHash): Promise<ProgramView | null> {
  return callZome("rewards", "program_of", catalogRef);
}

/// Sets up or changes the caller's store's program.
export async function saveProgram(program: RewardsProgram): Promise<ActionHash> {
  return callZome("rewards", "save_program", program);
}

/// The caller's card at a store, with its program.
export async function myCard(catalogRef: ActionHash): Promise<CardView> {
  return callZome("rewards", "my_card", catalogRef);
}

/// Every card the caller holds -- worked out on this device from their own
/// orders and what stores sealed to them: nothing about points is public.
export async function myCards(): Promise<CardView[]> {
  return callZome("rewards", "my_cards", null);
}

/// The caller's store giving a customer points -- citing `order` of theirs
/// there, or by default their latest.
export async function grantPoints(input: { to: AgentPubKey; catalog_ref: ActionHash; points: number; note: string; order?: ActionHash }): Promise<ActionHash> {
  return callZome("rewards", "grant_points", input);
}

export async function programStats(catalogRef: ActionHash): Promise<ProgramStats> {
  return callZome("rewards", "program_stats", catalogRef);
}

export async function myBirthMonth(): Promise<number | null> {
  return callZome("rewards", "my_birth_month", null);
}

/// Once, ever. Kept on this device; each store they order from is told,
/// sealed so only it can read it.
export async function setBirthMonth(month: number): Promise<void> {
  return callZome("rewards", "set_birth_month", month);
}

/// One of the caller's orders, as its points stand -- `null` if it earns none.
export async function orderPoints(order: ActionHash): Promise<OrderPoints | null> {
  return callZome("rewards", "order_points", order);
}
