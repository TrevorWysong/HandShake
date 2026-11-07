// Appeals of the store's decisions waiting for its side -- on any order,
// however old -- under its Issues tab.
import { useState } from "react";
import { Gavel } from "lucide-react";
import { answerAppeal } from "../../holochain/zomes/dispatch";
import { bytesToHex } from "../../holochain/decode";
import type { AppealView } from "../../holochain/types";
import { formatCents } from "../../lib/ui/format";
import { EvidenceSheet } from "./OrderAppeal";
import { Button, Card } from "../ui";
import { useT } from "../../i18n";

export function StoreAppeals({ waiting, onAnswered }: { waiting: AppealView[]; onAnswered: () => Promise<void> }) {
  const t = useT();
  const [answering, setAnswering] = useState<AppealView | null>(null);
  if (waiting.length === 0) return null;
  return (
    <Card className="p-4">
      <p className="flex items-center gap-2 font-bold text-ink-900 dark:text-ink-50">
        <Gavel size={16} /> {t("appeal.storeWaiting", { count: waiting.length })}
      </p>
      <p className="mt-0.5 text-xs text-ink-500">{t("appeal.storeIntro")}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {waiting.map((appeal) => (
          <li key={bytesToHex(appeal.appeal)} className="flex items-center justify-between gap-3 text-sm">
            <span>
              {t("appeal.storeAsks", { amount: formatCents(appeal.amount), total: formatCents(appeal.order_total) })}
            </span>
            <Button className="py-1.5 text-xs" onClick={() => setAnswering(appeal)}>
              {t("appeal.giveSideButton")}
            </Button>
          </li>
        ))}
      </ul>
      {answering && (
        <EvidenceSheet
          title={t("appeal.yourSide")}
          subtitle={t("appeal.onlyArbiter")}
          maxAmount={null}
          onClose={() => setAnswering(null)}
          onSend={async ({ note, photo }) => {
            await answerAppeal({ appeal: answering.appeal, note, photo_data_uri: photo });
            setAnswering(null);
            await onAnswered();
          }}
        />
      )}
    </Card>
  );
}
