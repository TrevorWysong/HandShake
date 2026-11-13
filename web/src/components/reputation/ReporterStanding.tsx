// For a store answering a customer's report about items: how often they
// report a problem -- their own action, of their recent orders -- and
// whether other stores found their reports weren't made in good faith,
// shown only once enough different stores have (docs/REPUTATION.md, phases
// 2 and 4), opening onto what each said and the customer's reply. Drivers
// never see it.
import { History, ShieldAlert } from "lucide-react";
import { getReportPattern } from "../../holochain/zomes/dispatch";
import { getReputationSummary } from "../../holochain/zomes/reputation";
import { bytesToHex } from "../../holochain/decode";
import type { AgentPubKey } from "../../holochain/types";
import { useResource } from "../../lib/hooks/useResource";
import { shownToStores } from "../../lib/reputation/findings";
import { useTerms } from "../../store/network";
import { FindingsSheet } from "./FindingsSheet";
import { useT } from "../../i18n";

export function ReporterStanding({ customer }: { customer: AgentPubKey }) {
  const t = useT();
  const minStores = useTerms().min_flagging_stores;
  const hex = bytesToHex(customer);
  const { data: summary } = useResource(`customer-history:${hex}`, () => getReputationSummary({ Customer: customer }));
  const { data: pattern } = useResource(`report-pattern:${hex}`, () => getReportPattern(customer));
  const flagged = !!summary && shownToStores(summary.bad_faith_stores, minStores);
  return (
    <>
      {pattern?.shown && (
        <p className="flex items-center gap-2 border-t border-ink-100 px-4 py-2.5 text-xs text-ink-600 dark:border-ink-800 dark:text-ink-300">
          <History size={14} className="shrink-0 text-ink-400" aria-hidden />
          {t("reportPattern.line", { reported: pattern.reported, count: pattern.orders })}
        </p>
      )}
      {flagged && <Flagged customer={customer} hex={hex} stores={summary.bad_faith_stores} />}
    </>
  );
}

function Flagged({ customer, hex, stores }: { customer: AgentPubKey; hex: string; stores: number }) {
  const t = useT();
  return (
    <div className="flex items-start gap-2.5 border-t border-amber-200/70 bg-amber-50 px-4 py-3 dark:border-amber-900/40 dark:bg-amber-950/30">
      <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="min-w-0 text-xs leading-relaxed text-amber-900 dark:text-amber-100">
        <p className="font-semibold">{t("findings.storesFound", { count: stores })}</p>
        <FindingsSheet target={{ Customer: customer }} targetKey={`customer:${hex}`} title={t("findings.customerTitle")} intro={t("findings.customerViewerIntro")}>
          {(open) => (
            <button type="button" onClick={open} className="mt-0.5 font-semibold underline underline-offset-2">
              {t("findings.seeWhat")}
            </button>
          )}
        </FindingsSheet>
      </div>
    </div>
  );
}
