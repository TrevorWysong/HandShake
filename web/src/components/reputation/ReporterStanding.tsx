// For a store answering a customer's report about items: whether other
// stores found their reports weren't made in good faith -- shown only once
// enough different stores have (docs/REPUTATION.md, phase 2), opening onto
// what each said and the customer's reply. Drivers never see it.
import { ShieldAlert } from "lucide-react";
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
  if (!summary || !shownToStores(summary.bad_faith_stores, minStores)) return null;
  return (
    <div className="flex items-start gap-2.5 border-t border-amber-200/70 bg-amber-50 px-4 py-3 dark:border-amber-900/40 dark:bg-amber-950/30">
      <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="min-w-0 text-xs leading-relaxed text-amber-900 dark:text-amber-100">
        <p className="font-semibold">{t("findings.storesFound", { count: summary.bad_faith_stores })}</p>
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
