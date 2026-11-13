// A store giving the customer on one of its orders points -- a thank-you,
// or an apology for a small inconvenience that no report covers (a late or
// cold order). The store's program is read only once the sheet opens, so a
// long order history costs nothing until it's used. A grant like any gift:
// only to the store's own customer, citing this order, bounded, sealed.
import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Gift } from "lucide-react";
import { grantPoints } from "../../holochain/zomes/rewards";
import type { ActionHash, AgentPubKey } from "../../holochain/types";
import { useAction } from "../../lib/hooks/useAction";
import { Button, Notice, Skeleton } from "../ui";
import { Sheet } from "../Sheet";
import { GoodwillPoints } from "./GoodwillPoints";
import { usePointsName, useRunningProgram } from "../../lib/hooks/useRunningProgram";
import { pickedPoints } from "../../lib/orders/issueAnswer";
import { useT } from "../../i18n";

export function GivePoints({ order, customer, catalogRef }: { order: ActionHash; customer: AgentPubKey; catalogRef: ActionHash }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [given, setGiven] = useState<string | null>(null);
  return (
    <>
      {given ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-presence-600" role="status">
          <Check size={14} aria-hidden /> {given}
        </p>
      ) : (
        <Button variant="ghost" className="mt-3 w-full py-2 text-xs" onClick={() => setOpen(true)}>
          <Gift size={14} aria-hidden /> {t("givePoints.open")}
        </Button>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title={t("givePoints.title")} subtitle={t("givePoints.subtitle")}>
        <GivePointsBody
          order={order}
          customer={customer}
          catalogRef={catalogRef}
          onGiven={(said) => {
            setGiven(said);
            setOpen(false);
          }}
        />
      </Sheet>
    </>
  );
}

function GivePointsBody({ order, customer, catalogRef, onGiven }: { order: ActionHash; customer: AgentPubKey; catalogRef: ActionHash; onGiven: (said: string) => void }) {
  const t = useT();
  const giving = useAction();
  const program = useRunningProgram(catalogRef);
  const name = usePointsName(program);
  const [points, setPoints] = useState<number | null>(null);
  const [note, setNote] = useState(() => t("givePoints.defaultNote"));
  if (program === undefined) return <Skeleton className="h-24 w-full" />;
  if (program === null) {
    return (
      <div className="rounded-2xl bg-ink-50 p-4 text-sm text-ink-600 dark:bg-ink-800/60 dark:text-ink-300">
        <p>{t("givePoints.noProgram")}</p>
        <Link to="/merchant/rewards" className="mt-2 inline-block font-semibold text-handshake-600">{t("givePoints.setUp")}</Link>
      </div>
    );
  }
  const amount = pickedPoints(program, points);
  const give = () => giving.run(async () => {
    if (amount === null) return;
    await grantPoints({ to: customer, catalog_ref: catalogRef, points: amount, note: note.trim(), order });
    onGiven(t("givePoints.given", { points: amount.toLocaleString(), name }));
  });
  return (
    <>
      <GoodwillPoints program={program} points={points} onPoints={setPoints} note={note} onNote={setNote} />
      <p className="mt-3 text-[0.6875rem] leading-relaxed text-ink-400">{t("givePoints.private", { program: program.name })}</p>
      {giving.error && <Notice className="mt-3">{giving.error}</Notice>}
      <Button className="mt-4 w-full" loading={giving.busy} disabled={amount === null || note.trim().length === 0} onClick={give}>
        {t("givePoints.give", { points: (amount ?? 0).toLocaleString(), name })}
      </Button>
    </>
  );
}
