// "…" on an order, a store or a driver: blocking any of the parties there
// (docs/REPUTATION.md, phase 4). Blocked either way, the two no longer see
// or deal with each other; the other isn't told, and only whoever blocked
// lifts it. Never automatic -- a low score never blocks anyone.
import { useState } from "react";
import { Ban, MoreHorizontal } from "lucide-react";
import { block, myBlocks, unblock } from "../../holochain/zomes/reputation";
import type { Party } from "../../holochain/types";
import { sameParty } from "../../lib/reputation/customers";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";
import { Button, Notice, Skeleton } from "../ui";
import { Sheet } from "../Sheet";
import { useT, type MessageKey } from "../../i18n";

/// A party on the screen that can be blocked, and what it is to the viewer.
export interface Blockable {
  party: Party;
  /// Its name, as shown here.
  name: string;
  role: "customer" | "store" | "driver";
}

const ROLE_COPY: Record<Blockable["role"], { block: MessageKey; effect: MessageKey }> = {
  customer: { block: "block.customer", effect: "block.customerEffect" },
  store: { block: "block.store", effect: "block.storeEffect" },
  driver: { block: "block.driver", effect: "block.driverEffect" },
};

/// `targets` are read only once the sheet opens -- a driver behind an order's
/// bid, a store's name -- so a list of cards costs nothing until it's used.
export function BlockActions({ by, targets, targetsKey, partyKey, onChanged }: { by: Party; targets: () => Promise<Blockable[]>; targetsKey: string; partyKey: string; onChanged?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={t("block.more")} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-400 transition hover:bg-ink-100 hover:text-ink-700 dark:hover:bg-ink-800 dark:hover:text-ink-200">
        <MoreHorizontal size={18} aria-hidden />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t("block.title")} subtitle={t("block.subtitle")}>
        <BlockBody by={by} targets={targets} targetsKey={targetsKey} partyKey={partyKey} onChanged={() => { setOpen(false); onChanged?.(); }} />
      </Sheet>
    </>
  );
}

function BlockBody({ by, targets: load, targetsKey, partyKey, onChanged }: { by: Party; targets: () => Promise<Blockable[]>; targetsKey: string; partyKey: string; onChanged: () => void }) {
  const t = useT();
  const { data: blocked, reload } = useResource(`my-blocks:${partyKey}`, () => myBlocks(by));
  const { data: targets } = useResource(`block-targets:${targetsKey}`, load);
  const [confirming, setConfirming] = useState<Blockable | null>(null);
  const acting = useAction();
  if (!blocked || !targets) return <Skeleton className="h-20 w-full" />;
  const isBlocked = (target: Blockable) => blocked.some((party) => sameParty(party, target.party));

  if (confirming) {
    const lifting = isBlocked(confirming);
    return (
      <div>
        <p className="text-sm leading-relaxed text-ink-700 dark:text-ink-200">{t(lifting ? "block.unblockEffect" : ROLE_COPY[confirming.role].effect, { name: confirming.name })}</p>
        {!lifting && <p className="mt-2 text-xs leading-relaxed text-ink-500 dark:text-ink-400">{t("block.quiet")}</p>}
        {acting.error && <Notice className="mt-3">{acting.error}</Notice>}
        <div className="mt-4 flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => setConfirming(null)}>{t("common.back")}</Button>
          <Button
            variant={lifting ? "primary" : "secondary"}
            className="flex-1"
            loading={acting.busy}
            onClick={() => acting.run(async () => {
              await (lifting ? unblock(by, confirming.party) : block(by, confirming.party));
              await reload();
              onChanged();
            })}
          >
            {t(lifting ? "block.unblockNamed" : "block.blockNamed", { name: confirming.name })}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {targets.map((target) => (
        <li key={`${target.role}:${target.name}`}>
          <button type="button" onClick={() => setConfirming(target)} className="flex w-full items-center gap-3 rounded-2xl bg-ink-50 p-3 text-left transition hover:bg-ink-100 dark:bg-ink-800/60 dark:hover:bg-ink-800">
            <Ban size={18} className="shrink-0 text-red-500" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink-900 dark:text-ink-50">{t(isBlocked(target) ? "block.unblockNamed" : ROLE_COPY[target.role].block, { name: target.name })}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
