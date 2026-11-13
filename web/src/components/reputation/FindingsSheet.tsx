// What stores have said about someone, opened from where it's shown -- read
// only when opened, so a list of orders or bids costs nothing until then.
import { useState, type ReactNode } from "react";
import { getFindings } from "../../holochain/zomes/reputation";
import type { ReputationTarget } from "../../holochain/types";
import { useResource } from "../../lib/hooks/useResource";
import { Skeleton } from "../ui";
import { Sheet } from "../Sheet";
import { FindingsList } from "./FindingsList";
import { useT } from "../../i18n";

export function FindingsSheet({ target, targetKey, title, intro, children }: { target: ReputationTarget; targetKey: string; title: string; intro: string; children: (open: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children(() => setOpen(true))}
      <Sheet open={open} onClose={() => setOpen(false)} title={title} subtitle={intro}>
        <FindingsBody target={target} targetKey={targetKey} />
      </Sheet>
    </>
  );
}

function FindingsBody({ target, targetKey }: { target: ReputationTarget; targetKey: string }) {
  const t = useT();
  const { data: findings } = useResource(`findings:${targetKey}`, () => getFindings(target));
  if (!findings) return <Skeleton className="h-24 w-full" />;
  const counted = findings.filter((f) => f.counts);
  if (counted.length === 0) return <p className="text-sm text-ink-500">{t("findings.none")}</p>;
  return <FindingsList findings={counted} />;
}
