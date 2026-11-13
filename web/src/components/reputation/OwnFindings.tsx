// What stores have said about the person reading, every finding -- counted
// or not yet -- each with the one public reply they may give
// (docs/REPUTATION.md, "Seen by its subject", "Answerable").
import type { FindingView } from "../../holochain/types";
import { FindingsList } from "./FindingsList";
import { useT } from "../../i18n";

export function OwnFindings({ findings, intro, onReplied }: { findings: FindingView[] | undefined; intro: string; onReplied: () => Promise<void> }) {
  const t = useT();
  if (!findings || findings.length === 0) return null;
  return (
    <div className="mt-4 border-t border-ink-100 pt-4 dark:border-ink-800">
      <h3 className="text-xs font-bold uppercase tracking-wide text-ink-400">{t("findings.whatStoresSaid")}</h3>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-ink-500 dark:text-ink-400">{intro}</p>
      <FindingsList findings={findings} mine onReplied={onReplied} />
    </div>
  );
}
