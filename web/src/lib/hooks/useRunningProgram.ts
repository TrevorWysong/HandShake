// A store's rewards program, if it's running one -- the points it gives
// mean nothing otherwise -- and what it calls them.
import { programOf } from "../../holochain/zomes/rewards";
import { bytesToHex } from "../../holochain/decode";
import type { ActionHash, RewardsProgram } from "../../holochain/types";
import { useResource } from "./useResource";
import { useT } from "../../i18n";

/// The store's program, if it's running one -- points mean nothing
/// otherwise -- or `undefined` while it's read.
export function useRunningProgram(catalogRef: ActionHash): RewardsProgram | null | undefined {
  const { data: view } = useResource(`program:${bytesToHex(catalogRef)}`, () => programOf(catalogRef));
  if (view === undefined) return undefined;
  return view?.program.active ? view.program : null;
}

/// What a program calls its points, or "points".
export function usePointsName(program: RewardsProgram | null | undefined): string {
  const t = useT();
  return program?.points_name || t("issueAnswer.points");
}
