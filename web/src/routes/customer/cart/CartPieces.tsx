// The cart's building blocks: a titled section, a note to someone, a chip
// to choose with, and an amount chosen from a few or typed in.
import { motion } from "framer-motion";
import clsx from "clsx";
import { currencySymbol } from "../../../lib/ui/format";
import { Card, Input, SectionLabel, Textarea } from "../../../components/ui";
import { fadeSlideUp } from "../../../lib/ui/motion";
import { MAX_NOTE_CHARS } from "../../../holochain/types";

export function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.div variants={fadeSlideUp}>
      <Card className="mt-4 p-4">
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel>{title}</SectionLabel>
          {right}
        </div>
        {children}
      </Card>
    </motion.div>
  );
}

/// A note for whoever it's for -- the store, or the driver -- and, if given,
/// who can read it.
export function NoteSection({ title, value, onChange, placeholder, privacy }: { title: string; value: string; onChange: (value: string) => void; placeholder: string; privacy?: string }) {
  return (
    <Section title={title}>
      <Textarea maxLength={MAX_NOTE_CHARS} value={value} onChange={(e) => onChange(e.target.value)} rows={2} placeholder={placeholder} />
      {privacy && <p className="mt-1.5 text-[11px] text-ink-400">{privacy}</p>}
    </Section>
  );
}

export function ToggleChip({ active, onClick, children, className }: { active: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
      className={clsx(
        "rounded-full px-3 py-1.5 text-xs font-semibold transition",
        active ? "bg-handshake-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500 hover:bg-ink-200 dark:hover:bg-ink-700",
        className
      )}
    >
      {children}
    </motion.button>
  );
}

/// One of a few amounts -- a chip each -- or any other typed in: choosing
/// one clears the other.
export function AmountChoice<T extends number>({ presets, label, preset, custom, onPreset, onCustom, placeholder }: {
  presets: readonly T[];
  label: (preset: T) => string;
  preset: T | null;
  custom: string;
  onPreset: (preset: T | null) => void;
  onCustom: (custom: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {presets.map((amount) => (
        <ToggleChip
          key={amount}
          active={preset === amount}
          onClick={() => {
            onPreset(amount);
            onCustom("");
          }}
        >
          {label(amount)}
        </ToggleChip>
      ))}
      <Input
        type="number"
        min={0}
        step={0.5}
        value={custom}
        onChange={(e) => {
          onCustom(e.target.value);
          onPreset(null);
        }}
        placeholder={placeholder}
        prefix={currencySymbol()}
        className="w-24 rounded-full py-1.5 text-xs"
      />
    </div>
  );
}
