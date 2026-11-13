// Missing and wrong items, once the customer has their order: they report
// them, the store accepts each report -- for all it's worth or a part --
// or declines it (its answer is final), with points as an apology if it
// likes (`IssueAnswer`),
// and when their report window has run the store's app settles the food --
// refunding what it accepted or never answered (see the dispatch `issues`
// module). Shown on both sides of the order.
import { useState } from "react";
import { TimeAgo } from "../TimeAgo";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, HeartPulse, CheckCircle2, Clock3, PackageX, Repeat2, ShieldCheck, Truck, XCircle } from "lucide-react";
import { getIssueItems, getIssuesForOrder, getOrderDecisions, reportIssue } from "../../holochain/zomes/dispatch";
import { bytesToHex } from "../../holochain/decode";
import { MAX_NOTE_CHARS, type IssueItems, type IssueKind, type IssueLine, type IssueView, type OrderDecisions } from "../../holochain/types";
import { claimedValue } from "../../lib/orders/issues";
import { formatCents, formatDeadline } from "../../lib/ui/format";
import { POLL } from "../../lib/network/poll";
import { useClock } from "../../lib/hooks/useClock";
import { useResource } from "../../lib/hooks/useResource";
import { Button, Card, Notice, Stepper, Textarea } from "../ui";
import { IssueAnswer } from "./IssueAnswer";
import { DeliveryReportSheet } from "./DeliveryReportSheet";
import { PhotoInput } from "../PhotoInput";
import { Sheet } from "../Sheet";
import { OrderAppeal } from "./OrderAppeal";
import { t as translate, useT, type MessageKey } from "../../i18n";
import { useAction } from "../../lib/hooks/useAction";
import { useTerms } from "../../store/network";

type Role = "customer" | "store";

/// What a customer picks: the public kind of report, or an allergen -- reported
/// as wrong, with that it was an allergen sealed to the store.
type ReportedAs = IssueKind | "Allergen";

const KIND_LABEL: Record<IssueKind, MessageKey> = { Missing: "issues.missing", Wrong: "issues.wrong" };

/// When the store's answers can last come: its app settles once the report
/// window has run and every report has had its grace -- `decide_order`'s rule.
function answerBy(decisions: OrderDecisions, issues: IssueView[], graceSecs: number): number | null {
  if (decisions.reports_until === null) return null;
  return Math.max(decisions.reports_until, ...issues.filter((issue) => issue.accepted === null).map((issue) => issue.reported_at + graceSecs * 1_000_000));
}

export function OrderIssues({ orderRef, role, onAnswered }: { orderRef: Uint8Array; role: Role; onAnswered?: () => void }) {
  const hex = bytesToHex(orderRef);
  const refresh = { pollMs: POLL.unsignalled, refreshOn: (s: object) => "IssueReported" in s || "OrderUpdated" in s || "OrderChanged" in s };
  const { data: decisions } = useResource(`order-decisions:${hex}`, () => getOrderDecisions(orderRef), refresh);
  const { data: issues, reload } = useResource(`issues:${hex}`, () => getIssuesForOrder(orderRef), refresh);
  const { data: items } = useResource(`issue-items:${hex}`, () => getIssueItems(orderRef));
  const [reporting, setReporting] = useState(false);
  const [reportingDelivery, setReportingDelivery] = useState(false);
  const now = useClock(30_000).getTime() * 1000;
  const graceSecs = useTerms().answer_grace_secs;

  if (!decisions || !issues || !items || decisions.not_delivered) return null;
  const open = decisions.refund === null;
  // The report window's run its course; the store's app is settling it.
  const answersUntil = answerBy(decisions, issues, graceSecs);
  const settling = open && answersUntil !== null && now >= (role === "store" ? answersUntil : decisions.reports_until!);
  if (!open && issues.length === 0) return null;
  if (role === "store" && issues.length === 0) return <StorePayoutNote decisions={decisions} orderTotal={items.order_total} />;

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-handshake-50 text-handshake-600 dark:bg-handshake-900/30 dark:text-handshake-400">
          <PackageX size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-ink-900 dark:text-ink-50">{headline(role, decisions, issues.length, settling, items.delivery_report_worth !== null)}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-500 dark:text-ink-400">{subline(role, decisions, settling, answersUntil)}</p>
        </div>
      </div>

      {issues.length > 0 && (
        <ul className="divide-y divide-ink-100 border-t border-ink-100 dark:divide-ink-800 dark:border-ink-800">
          {issues.map((issue) => (
            <IssueRow key={bytesToHex(issue.issue)} orderRef={orderRef} issue={issue} items={items} role={role} canAnswer={role === "store" && open} onAnswered={async () => { await reload(); onAnswered?.(); }} />
          ))}
        </ul>
      )}

      {!open && <OrderAppeal orderRef={orderRef} role={role} kept={items.order_total - (decisions.refund ?? 0)} />}

      {role === "customer" && open && !settling && (
        <div className="flex flex-wrap gap-2 border-t border-ink-100 p-4 dark:border-ink-800">
          <Button variant="ghost" className="min-w-0 flex-[1_1_12rem]" onClick={() => setReporting(true)}>
            {issues.some((issue) => !issue.service) ? translate("issues.reportMore") : translate("issues.report")}
          </Button>
          {items.delivery_report_worth !== null && !issues.some((issue) => issue.service) && (
            <Button variant="ghost" className="min-w-0 flex-[1_1_12rem]" onClick={() => setReportingDelivery(true)}>
              <Truck size={16} aria-hidden /> {translate("deliveryReport.open")}
            </Button>
          )}
        </div>
      )}

      {role === "customer" && items.delivery_report_worth !== null && (
        <DeliveryReportSheet
          open={reportingDelivery}
          onClose={() => setReportingDelivery(false)}
          orderRef={orderRef}
          worth={items.delivery_report_worth}
          onReported={async () => {
            setReportingDelivery(false);
            await reload();
          }}
        />
      )}

      {role === "customer" && (
        <ReportIssueSheet
          open={reporting}
          onClose={() => setReporting(false)}
          orderRef={orderRef}
          items={items}
          alreadyReported={issues}
          onReported={async () => {
            setReporting(false);
            await reload();
          }}
        />
      )}
    </Card>
  );
}

function headline(role: Role, decisions: OrderDecisions, count: number, settling: boolean, anyProblem: boolean): string {
  const refund = decisions.refund;
  if (refund !== null) return refund > 0 ? translate("issues.refunded", { amount: formatCents(refund) }) : role === "store" ? translate("issues.noRefund") : translate("issues.declined");
  if (settling) return translate("issues.settling");
  if (role === "store") return translate("issues.storeReported", { count });
  return count ? translate("issues.reportIn") : translate(anyProblem ? "issues.askAny" : "issues.ask");
}

function subline(role: Role, decisions: OrderDecisions, settling: boolean, answersUntil: number | null): string {
  if (decisions.refund !== null) {
    const refunded = decisions.refund > 0;
    if (role === "customer") return translate(refunded ? "issues.returned" : "issues.chargedInFull");
    return translate(refunded ? "issues.restYours" : "issues.allYours");
  }
  if (settling) return translate("issues.windowClosed");
  if (role === "store") return answersUntil !== null ? translate("issues.storeAnswerBy", { time: formatDeadline(answersUntil) }) : translate("issues.storeAnswer");
  const until = decisions.reports_until !== null ? formatDeadline(decisions.reports_until) : null;
  return until ? translate("issues.reportUntil", { time: until }) : translate("issues.reportForAWhile");
}

function StorePayoutNote({ decisions, orderTotal }: { decisions: OrderDecisions; orderTotal: number }) {
  if (decisions.refund !== null || decisions.reports_until === null) return null;
  return (
    <p className="mt-4 flex items-center gap-2 rounded-2xl bg-ink-50 px-4 py-3 text-xs text-ink-600 dark:bg-ink-800/60 dark:text-ink-300">
      <Clock3 size={14} className="shrink-0 text-ink-400" />
      {translate("issues.payoutAt", { amount: formatCents(orderTotal), time: formatDeadline(decisions.reports_until) })}
    </p>
  );
}

function IssueRow({ orderRef, issue, items, role, canAnswer, onAnswered }: { orderRef: Uint8Array; issue: IssueView; items: IssueItems; role: Role; canAnswer: boolean; onAnswered: () => Promise<void> }) {
  const t = useT();
  // Points given with the answer that couldn't be: said here, as the answer
  // form goes once it's answered.
  const [grantProblem, setGrantProblem] = useState<string | null>(null);
  const nameOf = (line: number) => {
    const ordered = items.lines[line];
    return ordered ? [ordered.name, ...ordered.choices].join(", ") : translate("issues.anItem");
  };

  return (
    <li className="p-4">
      <div className="flex items-start justify-between gap-3">
        {issue.service ? (
          <p className="flex min-w-0 items-center gap-2 text-sm">
            <Truck size={16} className="shrink-0 text-ink-500" aria-hidden />
            <span className="text-ink-800 dark:text-ink-100">{t("deliveryReport.row")}</span>
            <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide text-sky-800 dark:bg-sky-900/30 dark:text-sky-200">{t("deliveryReport.chip")}</span>
          </p>
        ) : (
        <ul className="flex min-w-0 flex-col gap-1.5">
          {issue.lines.map((line) => (
            <li key={line.line} className="flex items-center gap-2 text-sm">
              <span className="font-semibold tabular-nums text-ink-900 dark:text-ink-50">{line.quantity}×</span>
              <span className="truncate text-ink-800 dark:text-ink-100">{nameOf(line.line)}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${line.kind === "Missing" ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200" : "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-200"}`}>
                {t(KIND_LABEL[line.kind])}
              </span>
            </li>
          ))}
        </ul>
        )}
        <span className="shrink-0 text-sm font-bold tabular-nums text-ink-900 dark:text-ink-50">{formatCents(issue.value)}</span>
      </div>

      {issue.evidence?.allergen && <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-bold text-white"><HeartPulse size={13} /> {t("issues.allergenClaim")}</p>}
      {issue.evidence && (issue.evidence.note || issue.evidence.photo_data_uri) && (
        <div className="mt-3 flex gap-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-800/60">
          {issue.evidence.photo_data_uri && <img src={issue.evidence.photo_data_uri} alt={t("issues.customerPhoto")} className="h-16 w-16 shrink-0 rounded-lg object-cover" />}
          {issue.evidence.note && <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">“{issue.evidence.note}”</p>}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <StatusChip issue={issue} role={role} />
        <span className="text-[11px] text-ink-400"><TimeAgo at={issue.reported_at} /></span>
      </div>

      {canAnswer && issue.accepted === null && (
        <IssueAnswer
          orderRef={orderRef}
          issue={issue}
          items={items}
          onAnswered={async (problem) => {
            setGrantProblem(problem);
            await onAnswered();
          }}
        />
      )}
      {grantProblem && <Notice tone="warn" className="mt-2">{t("issueAnswer.grantFailed", { why: grantProblem })}</Notice>}
    </li>
  );
}

function StatusChip({ issue, role }: { issue: IssueView; role: Role }) {
  const part = issue.accepted === true && issue.refund !== null && issue.refund < issue.value;
  const [Icon, label, tone] =
    issue.accepted === true
      ? [
          CheckCircle2,
          part
            ? translate(role === "store" ? "issues.youAcceptedPart" : "issues.storeAcceptedPart", { amount: formatCents(issue.refund!), value: formatCents(issue.value) })
            : translate(role === "store" ? "issues.youAccepted" : "issues.storeAccepted"),
          "text-green-700 dark:text-green-300",
        ]
      : issue.accepted === false
        ? [XCircle, translate(role === "store" ? "issues.youDeclined" : "issues.storeDeclined"), "text-ink-600 dark:text-ink-300"]
        : [Clock3, translate(role === "store" ? "issues.waitingYou" : "issues.waitingStore"), "text-ink-500 dark:text-ink-400"];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${tone}`}>
      <Icon size={14} aria-hidden /> {label}
    </span>
  );
}

// --- reporting ---

/// Per line (by position): how many units, and what's wrong with them.
type Draft = Record<number, { quantity: number; kind: ReportedAs }>;

function ReportIssueSheet({
  open,
  onClose,
  orderRef,
  items,
  alreadyReported,
  onReported,
}: {
  open: boolean;
  onClose: () => void;
  orderRef: Uint8Array;
  items: IssueItems;
  alreadyReported: IssueView[];
  onReported: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>({});
  const t = useT();
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState("");
  const action = useAction();

  const orderTotal = items.order_total;
  const priced = items.lines.map((l) => ({ unitPrice: l.unit_price_cents, quantity: l.quantity }));
  const reported = alreadyReported.flatMap((i) => i.lines).map((l) => ({ line: l.line, quantity: l.quantity }));
  const reportedUnits = (line: number) => reported.filter((l) => l.line === line).reduce((n, l) => n + l.quantity, 0);
  const claimed = Object.entries(draft)
    .filter(([, d]) => d.quantity > 0)
    .map(([line, d]) => ({ line: Number(line), quantity: d.quantity }));
  // What this report adds to what's already reported -- the same arithmetic
  // the network uses for the refund.
  const estimate = claimedValue(priced, orderTotal, [...reported, ...claimed]) - claimedValue(priced, orderTotal, reported);

  function setUnits(line: number, quantity: number) {
    setDraft((d) => ({ ...d, [line]: { kind: d[line]?.kind ?? "Missing", quantity } }));
  }

  const submit = () => action.run(async () => {
    const lines: IssueLine[] = items.lines.flatMap((_, line) => {
      const d = draft[line];
      return d && d.quantity > 0 ? [{ line, quantity: d.quantity, kind: d.kind === "Allergen" ? ("Wrong" as const) : d.kind }] : [];
    });
    const allergen = Object.values(draft).some((d) => d.quantity > 0 && d.kind === "Allergen");
    await reportIssue({ order: orderRef, lines, note: note.trim(), photo_data_uri: photo, allergen });
    setDraft({});
    setNote("");
    setPhoto("");
    await onReported();
  });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("issues.sheetTitle")}
      subtitle={t("issues.sheetSubtitle")}
      footer={
        <>
          {action.error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{action.error}</p>}
          <Button className="w-full" disabled={claimed.length === 0} loading={action.busy} onClick={submit}>
            {claimed.length ? t("issues.reportButton", { amount: formatCents(estimate) }) : t("issues.chooseItem")}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-2">
        {items.lines.map((line, position) => {
          const max = line.quantity - reportedUnits(position);
          const d = draft[position];
          const units = d?.quantity ?? 0;
          return (
            <li key={position} className={`rounded-2xl border p-3 transition ${units > 0 ? "border-handshake-400 bg-handshake-50/40 dark:bg-handshake-900/10" : "border-ink-100 dark:border-ink-800"} ${max <= 0 ? "opacity-50" : ""}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{line.name}</p>
                  {line.choices.length > 0 && <p className="truncate text-xs text-ink-500">{line.choices.join(", ")}</p>}
                  <p className="text-xs text-ink-400">
                    {t("issues.ordered", { count: line.quantity })} · {t("cart.each", { price: formatCents(line.unit_price_cents) })}
                    {max < line.quantity && ` · ${t("issues.alreadyReported", { count: line.quantity - max })}`}
                  </p>
                </div>
                <Stepper value={units} max={Math.max(0, max)} onChange={(q) => setUnits(position, q)} />
              </div>
              <AnimatePresence initial={false}>
                {units > 0 && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("issues.whatsWrong", { item: line.name })}>
                      {(["Missing", "Wrong", "Allergen"] as const).map((kind) => (
                        <button
                          key={kind}
                          role="radio"
                          aria-checked={(d?.kind ?? "Missing") === kind}
                          onClick={() => setDraft((dr) => ({ ...dr, [position]: { quantity: units, kind } }))}
                          className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition ${
                            (d?.kind ?? "Missing") === kind ? "bg-ink-900 text-white dark:bg-ink-50 dark:text-ink-900" : "bg-white text-ink-600 ring-1 ring-ink-200 dark:bg-ink-900 dark:text-ink-300 dark:ring-ink-700"
                          }`}
                        >
                          {kind === "Missing" ? <AlertCircle size={13} /> : kind === "Wrong" ? <Repeat2 size={13} /> : <HeartPulse size={13} />}
                          {t(kind === "Allergen" ? "issues.allergen" : KIND_LABEL[kind])}
                        </button>
                      ))}
                    </div>
                    {d?.kind === "Allergen" && <p role="alert" className="mt-2 rounded-xl bg-red-50 p-3 text-xs font-semibold leading-relaxed text-red-800 dark:bg-red-950/40 dark:text-red-200">{t("issues.allergenMedical")}</p>}
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>

      <div className="mt-5">
        <p className="mb-2 text-xs font-semibold text-ink-500">{t("issues.tellMore")}</p>
        <Textarea value={note} maxLength={MAX_NOTE_CHARS} rows={3} placeholder={t("issues.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold text-ink-500">{t("issues.addPhoto")}</p>
        <PhotoInput value={photo} onChange={setPhoto} shape="banner" className="w-full" />
      </div>
      <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-ink-400">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" />
        {t("issues.privacy")}
      </p>
    </Sheet>
  );
}
