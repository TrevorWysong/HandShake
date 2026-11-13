// Stores' findings about someone, each with its reason and the one reply
// they may give (docs/REPUTATION.md). For its subject -- who sees which
// count, and can reply -- and for those it's shown to, who see the reply
// beside each.
import { useState } from "react";
import { MessageSquareQuote, ShieldAlert } from "lucide-react";
import { replyToFinding } from "../../holochain/zomes/reputation";
import { bytesToHex } from "../../holochain/decode";
import { MAX_REPLY_CHARS, type FindingView } from "../../holochain/types";
import { findingLabel } from "../../lib/reputation/findings";
import { useAction } from "../../lib/hooks/useAction";
import { Button, Notice, Textarea } from "../ui";
import { TimeAgo } from "../TimeAgo";
import { useT } from "../../i18n";

export function FindingsList({ findings, mine = false, onReplied }: { findings: FindingView[]; mine?: boolean; onReplied?: () => Promise<void> }) {
  return (
    <ul className="flex flex-col gap-2">
      {findings.map((finding) => (
        <FindingRow key={bytesToHex(finding.event)} finding={finding} mine={mine} onReplied={onReplied} />
      ))}
    </ul>
  );
}

function FindingRow({ finding, mine, onReplied }: { finding: FindingView; mine: boolean; onReplied?: () => Promise<void> }) {
  const t = useT();
  const replying = useAction();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const send = () => replying.run(async () => {
    await replyToFinding({ event: finding.event, text: draft.trim() });
    setOpen(false);
    await onReplied?.();
  });
  return (
    <li className="rounded-2xl bg-ink-50 p-3 dark:bg-ink-800/60">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="flex min-w-0 flex-[1_1_10rem] items-start gap-2 text-sm font-semibold text-ink-900 dark:text-ink-50">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          {t(findingLabel(finding.finding))}
        </p>
        <span className="shrink-0 text-[0.6875rem] text-ink-400"><TimeAgo at={finding.at} /></span>
      </div>
      {mine && !finding.counts && <p className="mt-1 pl-6 text-[0.6875rem] text-ink-500 dark:text-ink-400">{t("findings.notCounted")}</p>}
      {finding.reply ? (
        <blockquote className="mt-2 flex gap-2 border-l-2 border-ink-200 pl-3 text-xs leading-relaxed text-ink-600 dark:border-ink-700 dark:text-ink-300">
          <MessageSquareQuote size={14} className="mt-0.5 shrink-0 text-ink-400" aria-hidden />
          <span><span className="font-semibold">{t(mine ? "findings.yourReply" : "findings.theirReply")}</span> {finding.reply}</span>
        </blockquote>
      ) : mine && (
        open ? (
          <div className="mt-2 pl-6">
            <Textarea value={draft} maxLength={MAX_REPLY_CHARS} rows={2} placeholder={t("findings.replyPlaceholder")} onChange={(e) => setDraft(e.target.value)} aria-label={t("findings.reply")} />
            <p className="mt-1 text-[0.6875rem] text-ink-400">{t("findings.replyPublic")}</p>
            {replying.error && <Notice className="mt-2">{replying.error}</Notice>}
            <div className="mt-2 flex gap-2">
              <Button variant="ghost" className="flex-1 py-2 text-xs" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
              <Button className="flex-1 py-2 text-xs" loading={replying.busy} disabled={draft.trim().length === 0} onClick={send}>{t("findings.sendReply")}</Button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="mt-2 ml-6 text-xs font-semibold text-handshake-600 hover:underline dark:text-handshake-400">
            {t("findings.reply")}
          </button>
        )
      )}
    </li>
  );
}
