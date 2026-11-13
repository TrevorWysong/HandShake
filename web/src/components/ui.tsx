import type { HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { ChevronDown, Minus, Plus, type LucideIcon } from "lucide-react";
import { useState } from "react";
import clsx from "clsx";
import { Link } from "react-router-dom";
import { useT } from "../i18n";

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx("rounded-2xl bg-white dark:bg-ink-900/60 shadow-[var(--shadow-card)] border border-ink-100/60 dark:border-ink-800", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "primary",
  className,
  children,
  loading,
  disabled,
  ...rest
}: Omit<HTMLMotionProps<"button">, "children"> & { children?: ReactNode; variant?: ButtonVariant; loading?: boolean }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-full font-semibold text-sm px-5 py-3 transition disabled:opacity-40 disabled:pointer-events-none forced-colors:border forced-colors:border-solid";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-handshake-500 text-white hover:bg-handshake-600 shadow-[var(--shadow-glow)]",
    secondary: "bg-ink dark:bg-ink-100 text-white dark:text-ink-900 hover:opacity-90",
    ghost: "bg-transparent text-ink dark:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800 border border-ink-200 dark:border-ink-700",
    danger: "bg-red-600 text-white hover:bg-red-700",
  };
  return (
    <motion.button
      className={clsx(base, variants[variant], className)}
      disabled={disabled || loading}
      whileTap={disabled || loading ? undefined : { scale: 0.96 }}
      transition={{ duration: 0.12 }}
      {...rest}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </motion.button>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "brand" | "success" | "warn" | "danger"; children: ReactNode }) {
  const tones: Record<string, string> = {
    neutral: "bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200",
    brand: "bg-handshake-100 text-handshake-700 dark:bg-handshake-900/40 dark:text-handshake-300",
    success: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    warn: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    danger: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  };
  return <span className={clsx("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold", tones[tone])}>{children}</span>;
}

/// What's chosen, where high-contrast modes paint every background alike:
/// outlined instead.
const FORCED_SELECTED = "forced-colors:outline-2 forced-colors:outline-solid forced-colors:-outline-offset-2";

export function ChipRow({ children }: { children: ReactNode }) {
  return <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto pb-0.5">{children}</div>;
}

export function Chip({ active, onClick, children, tone = "default" }: { active: boolean; onClick: () => void; children: ReactNode; tone?: "default" | "danger" | "brand" }) {
  const activeClasses = tone === "danger" ? "bg-red-500 text-white" : tone === "brand" ? "bg-handshake-500 text-white" : "bg-ink-900 text-white dark:bg-white dark:text-ink-900";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "max-w-full shrink-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition",
        active ? clsx(activeClasses, FORCED_SELECTED) : "bg-ink-100 dark:bg-ink-800 text-ink-500 hover:bg-ink-200 dark:hover:bg-ink-700"
      )}
    >
      {children}
    </button>
  );
}

/// The one place "this is live, p2p, right now" gets a visual signature --
/// see index.css's doc comment on why presence-green is reserved rather
/// than used as a generic accent.
/// A pill-shaped tab switcher -- "Active / Past" style.
export function SegmentedTabs<T extends string>({ tabs, value, onChange }: { tabs: readonly { value: T; label: string; badge?: number }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap rounded-3xl bg-ink-100 dark:bg-ink-800 p-1 text-xs font-semibold">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={clsx("flex items-center gap-1.5 rounded-full px-3 py-1 transition", value === tab.value ? clsx("bg-white dark:bg-ink-950 shadow-sm text-ink-900 dark:text-white", FORCED_SELECTED) : "text-ink-400")}
        >
          {tab.label}
          {!!tab.badge && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-handshake-500 px-1 text-[10px] font-bold text-white">{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function PresenceDot({ live = true }: { live?: boolean }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-presence-400 opacity-75" />}
      <span className={clsx("relative inline-flex h-2.5 w-2.5 rounded-full", live ? "bg-presence-500" : "bg-ink-300 dark:bg-ink-600")} />
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={clsx("animate-spin h-5 w-5", className)} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

/// Nothing here yet, and -- with `action` -- the way to get something.
export function EmptyState({ icon, title, subtitle, action }: { icon?: ReactNode; title: string; subtitle?: string; action?: { label: string; to: string } }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6 text-ink-400 dark:text-ink-500">
      {icon && <div className="mb-4 opacity-60">{icon}</div>}
      <p className="font-semibold text-ink-600 dark:text-ink-300">{title}</p>
      {subtitle && <p className="text-sm mt-1 max-w-xs">{subtitle}</p>}
      {action && (
        <Link to={action.to} className="mt-5 rounded-full bg-handshake-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-glow)] transition hover:bg-handshake-600">
          {action.label}
        </Link>
      )}
    </div>
  );
}

/// A shimmering placeholder block matching the shape of the content that
/// will replace it (a row, a card, a line of text) -- used instead of a
/// bare centered `Spinner` for list-shaped loading states, so the layout
/// a screen is about to show is legible before any data arrives.
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton rounded-xl", className)} aria-hidden />;
}

/// Consistent "this number matters" treatment -- order totals, balances,
/// earnings, the transparency dashboard's stats. Tabular figures so
/// digits don't jitter the layout as they change, tight tracking for a
/// confident, editorial feel, one shared place to tune rather than each
/// screen hand-rolling its own `font-black` + color combination.
export function StatNumber({ children, className, tone = "default" }: { children: ReactNode; className?: string; tone?: "default" | "brand" | "success" | "danger" }) {
  const tones: Record<string, string> = {
    default: "text-ink-900 dark:text-ink-50",
    brand: "text-handshake-600 dark:text-handshake-400",
    success: "text-presence-600 dark:text-presence-400",
    danger: "text-red-600 dark:text-red-400",
  };
  return <span className={clsx("font-black tracking-tight tabular-nums", tones[tone], className)}>{children}</span>;
}

/// Shared "filled field" look for every text input, textarea, and select
/// in the app -- a soft tinted background that lifts to a crisper
/// white/dark surface plus a brand-colored ring on focus, instead of a
/// bare bordered box that just changes border color. One place to tune so
/// every form field in the app reads as the same, deliberately designed
/// control rather than each screen's raw browser default.
const fieldBase =
  "w-full rounded-xl border border-ink-200/70 dark:border-ink-700/70 bg-ink-50/80 dark:bg-ink-800/50 px-3.5 py-2.5 text-sm text-ink-900 dark:text-ink-50 placeholder:text-ink-400 dark:placeholder:text-ink-500 outline-none transition focus:border-handshake-400 focus:bg-white dark:focus:bg-ink-900 focus:ring-2 focus:ring-handshake-100 dark:focus:ring-handshake-900/40";

type Adornment = { prefix?: ReactNode; suffix?: ReactNode };

/// The same field, drawn around an input and its unit rather than on the
/// input itself, so the unit sits beside the text instead of over it.
const adornedField =
  "flex items-center gap-2 rounded-xl border border-ink-200/70 dark:border-ink-700/70 bg-ink-50/80 dark:bg-ink-800/50 px-3.5 py-2.5 text-sm transition focus-within:border-handshake-400 focus-within:bg-white dark:focus-within:bg-ink-900 focus-within:ring-2 focus-within:ring-handshake-100 dark:focus-within:ring-handshake-900/40";

/// `prefix`/`suffix` render as fixed, non-editable glyphs inside the field
/// (e.g. `prefix={currencySymbol()}` for an amount, `suffix="%"` for a percentage)
/// -- unlike placeholder text, these never disappear once the customer
/// starts typing, so the unit stays legible the whole time. `className`
/// sizes and places the whole field, unit included.
export function Input({ className, prefix, suffix, ...props }: InputHTMLAttributes<HTMLInputElement> & Adornment) {
  const rest = useNumberDraft(props);
  if (!prefix && !suffix) return <input className={clsx(fieldBase, className)} {...rest} />;
  return (
    <div className={clsx(adornedField, className)}>
      {prefix && <span className="shrink-0 font-medium text-ink-400">{prefix}</span>}
      <input className="w-full min-w-0 flex-1 bg-transparent text-ink-900 dark:text-ink-50 placeholder:text-ink-400 dark:placeholder:text-ink-500 outline-none" {...rest} />
      {suffix && <span className="shrink-0 font-medium text-ink-400">{suffix}</span>}
    </div>
  );
}

/// A number field bound to a number shows what's being typed -- empty once
/// cleared, "010" on the way to 10 -- and passes on only numbers, never an empty field;
/// once it loses focus it shows the number again. Bound straight to the
/// number, a cleared field snaps back to 0 and a typed 1 reads "01". Focusing
/// it selects what's there, so typing replaces it.
function useNumberDraft(props: InputHTMLAttributes<HTMLInputElement>): InputHTMLAttributes<HTMLInputElement> {
  const [draft, setDraft] = useState<string | null>(null);
  if (props.type !== "number" || typeof props.value !== "number") return props;
  const { onChange, onFocus, onBlur } = props;
  return {
    ...props,
    value: draft ?? props.value,
    onFocus: (e) => {
      e.target.select();
      onFocus?.(e);
    },
    onChange: (e) => {
      setDraft(e.target.value);
      if (e.target.value !== "" && !Number.isNaN(e.target.valueAsNumber)) onChange?.(e);
    },
    onBlur: (e) => {
      setDraft(null);
      onBlur?.(e);
    },
  };
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(fieldBase, "resize-none", className)} {...rest} />;
}

/// Native `<select>`s render their own platform-default arrow and chrome
/// that doesn't match anything else in this app -- `appearance-none` turns
/// that off, and a `ChevronDown` icon stands in for it, styled the same as
/// every other field.
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={clsx(fieldBase, "appearance-none pr-9", className)} {...rest}>
        {children}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
    </div>
  );
}

export function Checkbox({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={clsx(
        "h-4 w-4 shrink-0 rounded-md border-ink-300 dark:border-ink-600 text-handshake-500 accent-handshake-500 focus:ring-2 focus:ring-handshake-100 dark:focus:ring-handshake-900/40",
        className
      )}
      {...rest}
    />
  );
}

/// A persistent label above a field, rather than relying on placeholder
/// text -- placeholder text disappears the instant something's typed,
/// which reads as "this field has no label at all" once filled in.
/// Shared by every form in the app (onboarding, merchant storefront
/// details, goodie-bag creation, ...) specifically so every field looks
/// and behaves the same way regardless of which screen it's on, rather
/// than each screen inventing its own near-identical label markup.
/// An on/off setting -- a labelled switch, announced as one.
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-40", checked ? "bg-handshake-500" : "bg-ink-200 dark:bg-ink-700")}
    >
      <span className={clsx("inline-block h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  );
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs font-semibold text-ink-500">{label}</label>
      {children}
    </div>
  );
}

/// The small uppercase heading over a section of a screen -- with an icon
/// before it, if given.
export function SectionLabel({ icon, children, className, as: Tag = "p", id }: { icon?: ReactNode; children: ReactNode; className?: string; as?: "p" | "h2" | "h3"; id?: string }) {
  return (
    <Tag id={id} className={clsx("text-xs font-bold uppercase tracking-wide text-ink-400", icon && "flex items-center gap-1.5", className)}>
      {icon}
      {children}
    </Tag>
  );
}

/// The heading over a group of cards on a page -- above the cards' own
/// labels, so a page reads as a few groups -- with what it can add, if
/// anything (`action`), at its end.
export function GroupHeading({ icon: Icon, title, action, className }: { icon: LucideIcon; title: string; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx("mb-2 flex min-h-9 items-center justify-between gap-3 px-1", className)}>
      <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-ink-500">
        <Icon size={15} className="text-handshake-500" />
        {title}
      </h2>
      {action}
    </div>
  );
}

const NOTICE_TONES = {
  error: "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300",
  warn: "bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200",
} as const;

/// A message in a box: why something failed (`error`, announced to screen
/// readers as it appears), or what to watch out for (`warn`).
export function Notice({ tone = "error", children, className }: { tone?: keyof typeof NOTICE_TONES; children: ReactNode; className?: string }) {
  return (
    <p role={tone === "error" ? "alert" : undefined} className={clsx("rounded-lg px-3 py-2 text-xs", NOTICE_TONES[tone], className)}>
      {children}
    </p>
  );
}

/// A count to step up and down, from `min` to `max`.
export function Stepper({ value, min = 0, max, onChange }: { value: number; min?: number; max: number; onChange: (value: number) => void }) {
  const t = useT();
  const step = (to: number) => onChange(Math.min(max, Math.max(min, to)));
  const button = "grid h-9 w-9 place-items-center rounded-full transition disabled:opacity-30 text-ink-700 hover:bg-white dark:text-ink-200 dark:hover:bg-ink-700";
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-full bg-ink-100 p-0.5 dark:bg-ink-800">
      <button type="button" aria-label={t("item.fewer")} className={button} disabled={value <= min} onClick={() => step(value - 1)}>
        <Minus size={16} />
      </button>
      <span className="w-6 text-center text-sm font-bold tabular-nums text-ink-900 dark:text-ink-50">{value}</span>
      <button type="button" aria-label={t("item.more")} className={button} disabled={value >= max} onClick={() => step(value + 1)}>
        <Plus size={16} />
      </button>
    </div>
  );
}

/// A titled card of rows, on a screen of them (the wallet, the account) --
/// `divided` puts a rule between its rows.
export function CardSection({ title, divided = false, children }: { title: string; divided?: boolean; children: ReactNode }) {
  return (
    <div className="mb-4">
      <SectionLabel className="mb-2">{title}</SectionLabel>
      <Card className={clsx("overflow-hidden", divided && "divide-y divide-ink-100 dark:divide-ink-800")}>{children}</Card>
    </div>
  );
}
