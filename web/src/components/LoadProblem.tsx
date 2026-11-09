// A screen whose first read failed: why, and a way to try again -- instead of
// a skeleton that never fills.
import { CloudOff } from "lucide-react";
import { Button } from "./ui";
import { useAction } from "../lib/hooks/useAction";
import { describeError } from "../lib/ui/errors";
import { useT } from "../i18n";

/// `compact` sits inside a card rather than filling a screen.
export function LoadProblem({ error, onRetry, compact = false }: { error: unknown; onRetry: () => Promise<void>; compact?: boolean }) {
  const t = useT();
  const retrying = useAction();
  return (
    <div role="alert" className={compact ? "flex flex-col items-center py-2 text-center" : "mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center"}>
      <span className="grid h-12 w-12 place-items-center rounded-full bg-ink-100 text-ink-400 dark:bg-ink-800">
        <CloudOff size={22} />
      </span>
      <p className="mt-3 text-sm font-semibold text-ink-900 dark:text-ink-50">{t("load.failed")}</p>
      <p className="mt-1 text-xs text-ink-400">{describeError(error)}</p>
      <Button variant="ghost" className="mt-4 py-2 text-xs" loading={retrying.busy} onClick={() => retrying.run(onRetry)}>
        {t("load.retry")}
      </Button>
    </div>
  );
}
