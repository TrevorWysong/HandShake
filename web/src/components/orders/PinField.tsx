// A handover code typed in: the digits someone reads out, when their code
// can't be scanned.
import { HANDOFF_CODE_DIGITS } from "../../holochain/types";
import { t as translate } from "../../i18n";

/// Six digit boxes over one real input: one keyboard, paste works, and
/// screen readers hear a single field.
export function PinField({ value, onChange }: { value: string; onChange: (pin: string) => void }) {
  return (
    <label className="group relative block">
      <span className="sr-only">{translate("handoff.digits", { count: HANDOFF_CODE_DIGITS })}</span>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={HANDOFF_CODE_DIGITS}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, HANDOFF_CODE_DIGITS))}
        className="absolute inset-0 h-full w-full cursor-text opacity-0"
      />
      <span className="flex justify-between gap-1.5" aria-hidden>
        {Array.from({ length: HANDOFF_CODE_DIGITS }, (_, i) => {
          const active = i === Math.min(value.length, HANDOFF_CODE_DIGITS - 1);
          return (
            <span
              key={i}
              className={`grid h-14 flex-1 place-items-center rounded-xl border-2 bg-white font-mono text-2xl font-black text-ink-900 transition dark:bg-ink-900 dark:text-ink-50 ${
                active ? "border-ink-200 group-focus-within:border-handshake-500 dark:border-ink-700" : value[i] ? "border-ink-300 dark:border-ink-600" : "border-ink-200 dark:border-ink-700"
              }`}
            >
              {value[i] ?? ""}
            </span>
          );
        })}
      </span>
    </label>
  );
}
