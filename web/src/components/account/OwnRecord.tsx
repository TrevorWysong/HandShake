// Someone's own record, as others see it (docs/REPUTATION.md, "Seen by its
// subject"): the very lines shown to the people who decide whether to take
// their orders, who those are, and how long each counts. A customer's on
// their profile, a store's on its page; a driver's is under Earnings.
import type { ReactNode } from "react";
import { CheckCircle2, ShieldAlert, ShieldCheck } from "lucide-react";
import { getFindings, getReputationSummary } from "../../holochain/zomes/reputation";
import { bytesToHex } from "../../holochain/decode";
import type { ActionHash, AgentPubKey } from "../../holochain/types";
import { useResource } from "../../lib/hooks/useResource";
import { customerRecordLines, storeRecordLines } from "../../lib/reputation/recordLines";
import { useTerms } from "../../store/network";
import { Card, SectionLabel, Skeleton } from "../ui";
import { InfoSheet } from "../InfoSheet";
import { OwnFindings } from "../reputation/OwnFindings";
import { useT, type MessageKey } from "../../i18n";

/// A customer's own record, from the same reading stores and drivers make.
export function MyCustomerRecord({ me }: { me: AgentPubKey }) {
  const t = useT();
  const terms = useTerms();
  const days = terms.reputation_window_days;
  const { data: summary } = useResource(`customer-history:${bytesToHex(me)}`, () => getReputationSummary({ Customer: me }));
  const { data: findings, reload } = useResource(`own-findings:customer:${bytesToHex(me)}`, () => getFindings({ Customer: me }));
  return (
    <OwnRecord
      lines={summary ? customerRecordLines(summary, t) : undefined}
      more={!!findings && findings.length > 0}
      title="ownRecord.customer.title"
      seenBy="ownRecord.customer.seenBy"
      how={(["what", "who", "recover", "wrong", "findings"] as const).map((part) => ({ title: t(`ownRecord.customer.${part}`), body: t(`ownRecord.customer.${part}Detail`, { days, stores: terms.min_flagging_stores }) }))}
    >
      <OwnFindings findings={findings} intro={t("findings.customerIntro", { stores: terms.min_flagging_stores })} onReplied={reload} />
    </OwnRecord>
  );
}

/// A store's own record, from the same reading its customers and drivers make.
export function MyStoreRecord({ catalogRef }: { catalogRef: ActionHash }) {
  const t = useT();
  const days = useTerms().reputation_window_days;
  const { data: record } = useResource(`store-record:${bytesToHex(catalogRef)}`, () => getReputationSummary({ Store: catalogRef }));
  return (
    <OwnRecord
      lines={record ? storeRecordLines(record, t) : undefined}
      title="ownRecord.store.title"
      seenBy="ownRecord.store.seenBy"
      how={(["what", "who", "recover", "wrong"] as const).map((part) => ({ title: t(`ownRecord.store.${part}`), body: t(`ownRecord.store.${part}Detail`, { days }) }))}
    />
  );
}

/// `more`: what stores have said is listed below (`children`), so an empty
/// list of lines isn't "nothing on your record".
function OwnRecord({ lines, more = false, title, seenBy, how, children }: { lines: string[] | undefined; more?: boolean; title: MessageKey; seenBy: MessageKey; how: { title: string; body: string }[]; children?: ReactNode }) {
  const t = useT();
  const days = useTerms().reputation_window_days;
  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <SectionLabel as="h2" icon={<ShieldCheck size={13} aria-hidden />}>{t(title)}</SectionLabel>
        <InfoSheet title={t("ownRecord.how")} sections={how} />
      </div>
      {lines === undefined ? (
        <Skeleton className="h-12 w-full" />
      ) : lines.length === 0 && more ? null : lines.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl bg-green-50 p-3 dark:bg-green-950/30">
          <CheckCircle2 size={20} className="shrink-0 text-green-600 dark:text-green-400" aria-hidden />
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("ownRecord.clean")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t(title)}>
          {lines.map((line) => (
            <li key={line} className="flex items-start gap-2.5 rounded-2xl bg-amber-50 p-3 text-sm font-semibold text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              {line}
            </li>
          ))}
        </ul>
      )}
      {!(lines?.length === 0 && more) && <p className="mt-3 text-xs leading-relaxed text-ink-500 dark:text-ink-400">{t(seenBy)}</p>}
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-ink-400">{t("ownRecord.window", { days })}</p>
      {children}
    </Card>
  );
}
