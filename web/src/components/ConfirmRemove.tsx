// Taking something away for good, asked once more: a quiet link that opens
// a red panel saying what happens, with a way back -- the same wherever the
// app lets someone remove or end something.
import { useState } from "react";
import { Button } from "./ui";
import { useT } from "../i18n";

export function ConfirmRemove({ label, confirm, detail, action, busy, removing, onRemove, error, className }: {
  /// The link that starts it: "Remove from menu".
  label: string;
  /// What removing it does, in full.
  confirm: string;
  /// What else it touches, by name, said first: "Your “Free coffee”
  /// reward stops being offered".
  detail?: string | null;
  /// The button that does it: "Remove it".
  action: string;
  busy: boolean;
  removing: boolean;
  onRemove: () => void;
  /// Why it couldn't be removed, said where it was asked.
  error?: string | null;
  className?: string;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} disabled={busy} className={className ?? "self-center text-xs font-semibold text-red-600 underline-offset-4 hover:underline disabled:opacity-50 dark:text-red-400"}>
        {label}
      </button>
    );
  }
  return (
    <div role="group" aria-label={label} className="rounded-xl bg-red-50 p-3 dark:bg-red-900/20 forced-colors:border forced-colors:border-solid">
      {detail && <p className="mb-1.5 text-xs font-semibold leading-relaxed text-red-900 dark:text-red-100">{detail}</p>}
      <p className="text-xs leading-relaxed text-red-900 dark:text-red-100">{confirm}</p>
      {error && (
        <p role="alert" className="mt-2 text-xs font-semibold leading-relaxed text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <Button variant="ghost" className="flex-1 py-2 text-xs" disabled={busy} onClick={() => setConfirming(false)}>
          {t("common.back")}
        </Button>
        <Button variant="danger" className="flex-1 py-2 text-xs" loading={removing} disabled={busy} onClick={onRemove}>
          {action}
        </Button>
      </div>
    </div>
  );
}
