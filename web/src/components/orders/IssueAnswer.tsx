// A store answering a customer's report: refund all it's worth, a part of
// it, or none -- and, with any of them, points as an apology when the store
// runs a rewards program. One confirm says exactly what happens. The
// answer is final; the points are a grant of their own, given once the
// answer's in (`issueAnswer.ts`).
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Gift } from "lucide-react";
import { respondToIssue } from "../../holochain/zomes/dispatch";
import { grantPoints } from "../../holochain/zomes/rewards";
import type { Finding, IssueItems, IssueView } from "../../holochain/types";
import { recordFinding } from "../../holochain/zomes/reputation";
import { FindingChoice, type FindingKind } from "./FindingChoice";
import { GoodwillPoints } from "../rewards/GoodwillPoints";
import { usePointsName, useRunningProgram } from "../../lib/hooks/useRunningProgram";
import { partIn, pickedPoints, quickParts } from "../../lib/orders/issueAnswer";
import { centsTyped, currencySymbol, formatCents, fromMinorUnits } from "../../lib/ui/format";
import { useAction } from "../../lib/hooks/useAction";
import { Button, Chip, Input, Notice, SegmentedTabs, Switch } from "../ui";
import { useT, type MessageKey } from "../../i18n";

type Refund = "all" | "part" | "none";

/// `onAnswered` is told what couldn't be done after the answer -- points
/// not given, a finding not recorded -- for the report's row to say, since
/// this goes once it's answered.
export function IssueAnswer({ orderRef, issue, items, onAnswered }: { orderRef: Uint8Array; issue: IssueView; items: IssueItems; onAnswered: (problems: string[]) => Promise<void> }) {
  const t = useT();
  const answering = useAction();
  const [refund, setRefund] = useState<Refund>("all");
  const [partCents, setPartCents] = useState(() => quickParts(issue.value)[1] ?? quickParts(issue.value)[0] ?? 0);
  const [giving, setGiving] = useState(false);
  const [points, setPoints] = useState<number | null>(null);
  const [note, setNote] = useState(() => t("issueAnswer.defaultNote"));
  // Points only where there's a program running to spend them in.
  const running = useRunningProgram(items.catalog_ref) ?? null;
  const pointsName = usePointsName(running);
  const given = giving && running ? pickedPoints(running, points) : null;

  // A finding fits only some answers: bad faith on a declined report about
  // items; the driver at fault on a refunded report about the delivery,
  // with something the customer said for the driver to answer.
  const [finding, setFinding] = useState<Finding | null>(null);
  const findingKind: FindingKind | null = refund === "none" ? (issue.service ? null : "badFaith") : issue.service ? "driverAtFault" : null;
  const customerSaid = !!issue.evidence && (issue.evidence.note.trim().length > 0 || issue.evidence.photo_data_uri.length > 0);
  // One chosen for another answer (the refund changed since) doesn't carry over.
  const fits = (f: Finding) => (findingKind === "badFaith" ? "BadFaith" in f : findingKind === "driverAtFault" && "DriverAtFault" in f);
  const findingMade = finding && fits(finding) ? finding : null;

  const part = partIn(partCents, issue.value);
  const refunds = refund === "all" ? issue.value : refund === "part" ? part : 0;
  const ready = refunds !== null && (!giving || !running || (given !== null && note.trim().length > 0));

  const confirm = () => answering.run(async () => {
    await respondToIssue(issue.issue, refund !== "none", refund === "part" ? part : null);
    // The answer stands on its own: points or a finding that couldn't be
    // recorded are said so, never a reason to undo it.
    const problems: string[] = [];
    const attempt = async (what: MessageKey, step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (e) {
        problems.push(t(what, { why: e instanceof Error ? e.message : String(e) }));
      }
    };
    if (given !== null && running) await attempt("issueAnswer.grantFailed", () => grantPoints({ to: items.customer, catalog_ref: items.catalog_ref, points: given, note: note.trim(), order: orderRef }));
    if (findingMade) await attempt("findingChoice.failed", () => recordFinding({ order: orderRef, issue: issue.issue, finding: findingMade }));
    await onAnswered(problems);
  });

  const label =
    refund === "none"
      ? t("issueAnswer.confirmDecline")
      : t("issueAnswer.confirmRefund", { amount: formatCents(refunds ?? 0) });

  return (
    <div className="mt-3 rounded-2xl border border-ink-100 p-3 dark:border-ink-800">
      <SegmentedTabs
        tabs={[
          { value: "all", label: t("issueAnswer.all", { amount: formatCents(issue.value) }) },
          ...(quickParts(issue.value).length > 0 ? [{ value: "part" as const, label: t("issueAnswer.part") }] : []),
          { value: "none", label: t("issueAnswer.none") },
        ]}
        value={refund}
        onChange={setRefund}
      />

      <AnimatePresence initial={false} mode="wait">
        {refund === "part" && (
          <motion.div key="part" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input
                type="number"
                min={0}
                step={0.5}
                value={fromMinorUnits(partCents)}
                onChange={(e) => setPartCents(centsTyped(e.target.value))}
                prefix={currencySymbol()}
                aria-label={t("issueAnswer.partLabel")}
                aria-invalid={part === null}
                className="min-w-0 flex-[1_1_6rem] py-1.5 text-sm"
              />
              <span className="text-xs text-ink-500 dark:text-ink-400">{t("issueAnswer.ofValue", { amount: formatCents(issue.value) })}</span>
              <div className="flex flex-wrap gap-1.5">
                {quickParts(issue.value).map((cents) => (
                  <Chip key={cents} active={partCents === cents} onClick={() => setPartCents(cents)}>
                    {formatCents(cents)}
                  </Chip>
                ))}
              </div>
            </div>
            {part === null && <p className="mt-1.5 text-[0.6875rem] font-semibold text-red-500">{t("issueAnswer.partBounds", { amount: formatCents(issue.value) })}</p>}
          </motion.div>
        )}
        {refund === "none" && (
          <motion.p key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-3 text-xs leading-relaxed text-ink-600 dark:text-ink-300">
            {t("issues.declineWarning")}
          </motion.p>
        )}
      </AnimatePresence>

      {running && (
        <div className="mt-3 border-t border-ink-100 pt-3 dark:border-ink-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex min-w-0 flex-[1_1_12rem] items-center gap-2">
              <Gift size={16} className="shrink-0 text-handshake-500" aria-hidden />
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-ink-700 dark:text-ink-200">{t("issueAnswer.give", { points: pointsName })}</span>
                <span className="block text-[0.6875rem] text-ink-400">{t("issueAnswer.giveDetail", { program: running.name })}</span>
              </span>
            </span>
            <Switch checked={giving} onChange={setGiving} label={t("issueAnswer.give", { points: pointsName })} />
          </div>
          <AnimatePresence initial={false}>
            {giving && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="mt-3">
                  <GoodwillPoints program={running} points={points} onPoints={setPoints} note={note} onNote={setNote} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {findingKind && (
        <FindingChoice
          kind={findingKind}
          finding={findingMade}
          onChange={setFinding}
          unavailable={findingKind === "driverAtFault" && !customerSaid ? "findingChoice.faultNothingSaid" : undefined}
        />
      )}

      <Button variant={refund === "none" ? "secondary" : "primary"} className="mt-3 w-full py-2" loading={answering.busy} disabled={!ready} onClick={confirm}>
        {given !== null ? t("issueAnswer.withPoints", { answer: label, points: given.toLocaleString(), name: pointsName }) : label}
      </Button>
      {answering.error && <Notice className="mt-2">{answering.error}</Notice>}
    </div>
  );
}
