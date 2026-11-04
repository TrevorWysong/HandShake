// What went wrong, as a sentence in the person's language.
//
// Holochain zome-call failures surface as raw Wasm/Ribosome runtime traces,
// e.g. `Wasm runtime error while working with Ribosome: RuntimeError:
// dispatch::orders:412: Guest("This order isn't taking offers any more.")`.
// The only part meant for a human is the text inside Guest(...). A refusal
// a person can meet -- from a zome, the device runtime or the payment agent -- is
// in the generated table (`i18n/refusals.ts`), written in English by its
// source: it's shown translated, its values filled back in (an amount,
// named `..._cents`, in the network's currency). A zome's lowercase
// message is a diagnostic, not a sentence for people: it's shown as
// something having gone wrong, with the detail kept for support.
//
// A write the network's rules refused carries no Guest(...): its reason
// follows "Validation failed while committing:", and is shown as what was
// refused. One that only needs the network to catch up says to try again.
// Any other runtime trace is never shown as it is.
import { REFUSALS } from "../../i18n/refusals";
import { t } from "../../i18n";
import { formatCents } from "./format";

type RefusalKey = keyof typeof REFUSALS;

/// Each refusal by its exact text, and those with values as patterns that
/// read the values back.
const exact = new Map<string, RefusalKey>();
const patterns: { key: RefusalKey; names: string[]; pattern: RegExp }[] = [];
for (const [key, english] of Object.entries(REFUSALS) as [RefusalKey, string][]) {
  const names = [...english.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (names.length === 0) {
    exact.set(english, key);
    continue;
  }
  const literal = english.split(/\{\w+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  patterns.push({ key, names, pattern: new RegExp(`^${literal.join("(.+?)")}$`) });
}

/// `text` in the person's language, if it's a known refusal.
function translated(text: string): string | null {
  const key = exact.get(text);
  if (key) return t(key);
  for (const { key, names, pattern } of patterns) {
    const values = text.match(pattern);
    if (!values) continue;
    const vars: Record<string, string> = {};
    names.forEach((name, i) => {
      const value = values[i + 1];
      vars[name] = name.endsWith("_cents") && /^\d+$/.test(value) ? formatCents(Number(value)) : value;
    });
    return t(key, vars);
  }
  return null;
}

/// The refusal inside a failure: the innermost `Guest("...")`. A zome that
/// calls another (`call`) gets the other's failure back wrapped in its own,
/// escaped once more for each level -- `Host("... Guest(\"...\")")`.
function guestText(raw: string): string | null {
  let found: { depth: number; text: string } | null = null;
  for (const match of raw.matchAll(/Guest\((\\*)"([\s\S]*?)(?<!\\)\1"\)/g)) {
    const depth = match[1].length;
    if (found && depth <= found.depth) continue;
    let text = match[2];
    for (let level = 0; level < depth; level++) text = text.replace(/\\([\\"])/g, "$1");
    found = { depth, text: text.replace(/\\"/g, '"').replace(/\\n/g, " ") };
  }
  return found?.text ?? null;
}

/// Why the network's rules refused a write, as its rule says it --
/// unescaped from however many calls it came back through.
function validationText(raw: string): string | null {
  const reason = raw.match(/Validation failed while committing: ([\s\S]*?)(?:\\*"\)|$)/)?.[1];
  return reason ? reason.replace(/\\+(["\\])/g, "$1").trim() : null;
}

/// A failure that passes on its own: what a write rests on hasn't arrived
/// yet, or this device's database was busy.
const RETRYABLE = /may be retried|DepMissingFromDht|database is locked|timed out|Timeout/i;

/// A runtime trace, not words for people.
const TECHNICAL = /RuntimeError|Ribosome|Source chain error|WasmError|Host\(|Guest\(|\w+::\w+/;

/// `text` as a sentence: capitalised, and ending in a full stop.
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".");

export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = guestText(raw);
  if (text !== null) return translated(text) ?? (/^[a-z]/.test(text) ? t("error.unexpected", { detail: text }) : text);
  const refused = validationText(raw);
  if (refused) return translated(sentence(refused)) ?? t("error.refused", { reason: sentence(refused) });
  if (RETRYABLE.test(raw)) return t("error.retry");
  return translated(raw) ?? (TECHNICAL.test(raw) ? t("error.generic") : raw);
}
