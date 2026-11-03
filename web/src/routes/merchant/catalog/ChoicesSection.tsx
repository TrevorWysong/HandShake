// A store's choice groups -- "Size", "Milk", "Choose a side" -- as DoorDash's
// and Uber Eats' menu builders have them: shared by the items that list
// them, each required or optional with a minimum and maximum, a number of
// free choices, and options with prices that can be sold out or open a
// nested group. Attaching a group to an item is on the item's own form.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ListChecks, Pencil, Plus, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { createModifierGroup, updateModifierGroup } from "../../../holochain/zomes/catalog";
import { bytesEqual, bytesToHex, hexToBytes } from "../../../holochain/decode";
import type { ModifierGroup, ModifierOption } from "../../../holochain/types";
import { MAX_GROUP_OPTIONS, MAX_NAME_CHARS, MAX_OPTION_QUANTITY } from "../../../holochain/types";
import { groupProblem, rangeLabel } from "../../../lib/storefront/choices";
import { currencySymbol, fromMinorUnits, toMinorUnits } from "../../../lib/ui/format";
import { fadeSlideUp } from "../../../lib/ui/motion";
import { Button, Card, Field, Input, SectionLabel, Select, Switch } from "../../../components/ui";
import { useT, type MessageKey } from "../../../i18n";
import { useAction } from "../../../lib/hooks/useAction";

/// One of the store's choice groups: its identity and latest content.
export interface GroupRow {
  hash: Uint8Array;
  group: ModifierGroup;
}

type Editing = { kind: "new" } | { kind: "edit"; row: GroupRow } | null;

export function ChoicesSection({ catalogRef, groups, onChanged }: { catalogRef: Uint8Array; groups: GroupRow[]; onChanged: () => Promise<void> }) {
  const t = useT();
  const [editing, setEditing] = useState<Editing>(null);
  return (
    <motion.div variants={fadeSlideUp} className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel icon={<ListChecks size={13} />}>{t("choicesEditor.title")}</SectionLabel>
        <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setEditing(editing ? null : { kind: "new" })}>
          {editing ? <X size={14} /> : <Plus size={14} />} {editing ? t("common.cancel") : t("choicesEditor.add")}
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {editing && (
          <motion.div key={editing.kind === "edit" ? bytesToHex(editing.row.hash) : "new"} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <GroupForm
              catalogRef={catalogRef}
              row={editing.kind === "edit" ? editing.row : null}
              others={groups.filter((g) => editing.kind !== "edit" || !bytesEqual(g.hash, editing.row.hash))}
              onSaved={async () => {
                setEditing(null);
                await onChanged();
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {groups.length === 0 && !editing ? (
        <p className="rounded-2xl border border-ink-100 bg-white p-4 text-xs leading-relaxed text-ink-400 dark:border-ink-800 dark:bg-ink-900">
          {t("choicesEditor.empty")}
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-ink-100 rounded-2xl border border-ink-100 bg-white dark:divide-ink-800 dark:border-ink-800 dark:bg-ink-900">
          {groups.map((row) => (
            <div key={bytesToHex(row.hash)} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{row.group.name}</p>
                <p className="truncate text-xs text-ink-400">
                  {row.group.min_selections > 0 ? t("item.required") : t("choicesEditor.optional")} · {rangeLabel(row.group)} · {row.group.options.map((o) => o.name).join(", ")}
                </p>
              </div>
              <button onClick={() => setEditing({ kind: "edit", row })} className="text-ink-400 hover:text-handshake-600" aria-label={t("choicesEditor.edit", { name: row.group.name })}>
                <Pencil size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

type ChoiceMode = "one" | "any" | "range";
const CHOICE_MODES: { value: ChoiceMode; label: MessageKey; detail: MessageKey }[] = [
  { value: "one", label: "choicesEditor.mode.one", detail: "choicesEditor.mode.oneDetail" },
  { value: "any", label: "choicesEditor.mode.any", detail: "choicesEditor.mode.anyDetail" },
  { value: "range", label: "choicesEditor.mode.range", detail: "choicesEditor.mode.rangeDetail" },
];

/// An option as the form edits it: its price as typed, in major units.
interface OptionDraft {
  id: number;
  name: string;
  price: string;
  available: boolean;
  /// The group it opens, by hex, or "".
  opens: string;
}

function GroupForm({ catalogRef, row, others, onSaved }: { catalogRef: Uint8Array; row: GroupRow | null; others: GroupRow[]; onSaved: () => Promise<void> }) {
  const t = useT();
  const initial = row?.group;
  const [name, setName] = useState(initial?.name ?? "");
  // How customers choose: one option, any number of them, or a range --
  // a new group takes one, as a size does.
  const [mode, setMode] = useState<ChoiceMode>(() => (!initial || (initial.min_selections === 1 && initial.max_selections === 1) ? "one" : initial.min_selections === 0 ? "any" : "range"));
  const [min, setMin] = useState(Math.max(1, initial?.min_selections ?? 1));
  const [max, setMax] = useState(initial?.max_selections == null ? "" : String(initial.max_selections));
  const [free, setFree] = useState(initial?.free_selections ?? 0);
  const [perOption, setPerOption] = useState(initial?.max_per_option ?? 1);
  const [more, setMore] = useState(free > 0 || perOption > 1);
  const [options, setOptions] = useState<OptionDraft[]>(
    () => initial?.options.map((o) => ({ id: o.id, name: o.name, price: o.price_cents > 0 ? fromMinorUnits(o.price_cents).toFixed(2) : "", available: o.available, opens: o.nested_group ? bytesToHex(o.nested_group) : "" })) ?? [{ id: 1, name: "", price: "", available: true, opens: "" }],
  );
  // Ids stay unique for the group's life, so an id an old order names is
  // never another option's.
  const [nextId, setNextId] = useState(() => Math.max(0, ...(initial?.options.map((o) => o.id) ?? [1])) + 1);
  const action = useAction();
  // What's missing shows once they've tried to save, not while they type.
  const [tried, setTried] = useState(false);

  const group: ModifierGroup = {
    catalog_ref: initial?.catalog_ref ?? catalogRef,
    name: name.trim(),
    min_selections: mode === "one" ? 1 : mode === "any" ? 0 : min,
    max_selections: mode === "one" ? 1 : max.trim() === "" ? null : Number(max),
    max_per_option: perOption,
    free_selections: free,
    options: options.map((o): ModifierOption => ({ id: o.id, name: o.name.trim(), price_cents: toMinorUnits(Number(o.price) || 0), available: o.available, nested_group: o.opens ? hexToBytes(o.opens) : null })),
  };
  const problem = groupProblem(group);
  const setOption = (id: number, patch: Partial<OptionDraft>) => setOptions((all) => all.map((o) => (o.id === id ? { ...o, ...patch } : o)));

  function save() {
    setTried(true);
    if (problem) return;
    return action.run(async () => {
      if (row) await updateModifierGroup(row.hash, group);
      else await createModifierGroup(group);
      await onSaved();
    });
  }

  return (
    <Card className="mb-4 flex flex-col gap-3 p-4">
      <Field label={t("choicesEditor.name")}>
        <Input maxLength={MAX_NAME_CHARS} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("choicesEditor.namePlaceholder")} />
      </Field>
      <div>
        <p className="mb-1.5 text-xs font-semibold text-ink-500">{t("choicesEditor.how")}</p>
        <div role="radiogroup" aria-label={t("choicesEditor.how")} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {CHOICE_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              onClick={() => setMode(m.value)}
              className={clsx(
                "rounded-xl border-2 px-3 py-2.5 text-left transition",
                mode === m.value ? "border-handshake-500 bg-handshake-50/60 dark:bg-handshake-900/20" : "border-ink-100 hover:border-ink-200 dark:border-ink-800 dark:hover:border-ink-700",
              )}
            >
              <span className="block text-sm font-semibold text-ink-900 dark:text-ink-50">{t(m.label)}</span>
              <span className="block text-xs text-ink-400">{t(m.detail)}</span>
            </button>
          ))}
        </div>
      </div>
      {mode === "any" && (
        <Field label={t("choicesEditor.mostPicks")}>
          <Input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} placeholder={t("storeSettings.noLimit")} className="w-40" />
        </Field>
      )}
      {mode === "range" && (
        <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
          <Field label={t("choicesEditor.atLeast")}>
            <Input type="number" min={1} value={min} onChange={(e) => setMin(Math.max(1, Math.floor(Number(e.target.value))))} />
          </Field>
          <Field label={t("choicesEditor.atMost")}>
            <Input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} placeholder={t("storeSettings.noLimit")} />
          </Field>
        </div>
      )}

      <button type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} className="flex items-center gap-1 self-start text-xs font-semibold text-handshake-600 dark:text-handshake-400">
        <ChevronDown size={14} className={clsx("transition-transform", more && "rotate-180")} /> {t("choicesEditor.more")}
      </button>
      {more && (
        <div className="flex flex-col gap-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-800/50">
          <Field label={t("choicesEditor.free")}>
            <Input type="number" min={0} value={free} onChange={(e) => setFree(Math.max(0, Math.floor(Number(e.target.value))))} suffix={t("choicesEditor.freeUnit")} className="w-40" />
            <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{t("choicesEditor.freeHint")}</p>
          </Field>
          <Field label={t("choicesEditor.perOption")}>
            <Select value={perOption} onChange={(e) => setPerOption(Number(e.target.value))}>
              {Array.from({ length: MAX_OPTION_QUANTITY }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {t("choicesEditor.times", { count: n })}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{t("choicesEditor.perOptionHint")}</p>
          </Field>
        </div>
      )}

      {/* The group as a customer meets it on the item's sheet. */}
      <div className="rounded-xl border border-dashed border-ink-200 p-3 dark:border-ink-700">
        <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">{t("choicesEditor.preview")}</p>
        <div className="mt-1.5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-ink-900 dark:text-ink-50">{group.name || t("choicesEditor.namePlaceholder")}</p>
            <p className="text-xs text-ink-400">
              {rangeLabel(group).replace(/^./, (c) => c.toUpperCase())}
              {group.free_selections > 0 && ` · ${t("item.free", { count: group.free_selections })}`}
            </p>
          </div>
          {group.min_selections > 0 && <span className="shrink-0 rounded-full bg-ink-100 px-2.5 py-1 text-[11px] font-semibold text-ink-600 dark:bg-ink-800 dark:text-ink-300">{t("item.required")}</span>}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold text-ink-500">{t("choicesEditor.options")}</p>
        {options.map((o) => (
          <div key={o.id} className="rounded-xl border border-ink-100 p-2.5 dark:border-ink-800">
            <div className="flex items-center gap-2">
              <Input className="min-w-0 flex-1" maxLength={MAX_NAME_CHARS} value={o.name} onChange={(e) => setOption(o.id, { name: e.target.value })} placeholder={t("choicesEditor.optionName")} />
              <div className="w-28 shrink-0">
                <Input className="pl-8" type="number" inputMode="decimal" min={0} step={0.01} value={o.price} onChange={(e) => setOption(o.id, { price: e.target.value })} placeholder="0.00" prefix={`+${currencySymbol()}`} aria-label={t("choicesEditor.price", { option: o.name || t("choicesEditor.option") })} />
              </div>
              <button type="button" aria-label={t("choicesEditor.remove")} disabled={options.length === 1} onClick={() => setOptions((all) => all.filter((x) => x.id !== o.id))} className="text-ink-400 hover:text-red-600 disabled:opacity-30">
                <Trash2 size={15} />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <label className="flex items-center gap-2 whitespace-nowrap text-xs text-ink-500">
                <Switch label={t("choicesEditor.inStockOf", { option: o.name || t("choicesEditor.option") })} checked={o.available} onChange={(available) => setOption(o.id, { available })} />
                {o.available ? t("choicesEditor.inStock") : t("item.soldOut")}
              </label>
              {others.length > 0 && (
                <Select className="min-w-[12rem] flex-1 py-1.5 text-xs" value={o.opens} onChange={(e) => setOption(o.id, { opens: e.target.value })}>
                  <option value="">{t("choicesEditor.nothingMore")}</option>
                  {others.map((g) => (
                    <option key={bytesToHex(g.hash)} value={bytesToHex(g.hash)}>
                      {t("choicesEditor.thenChoose", { name: g.group.name })}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          </div>
        ))}
        {options.length < MAX_GROUP_OPTIONS && (
          <Button
            variant="ghost"
            className="py-2 text-xs"
            onClick={() => {
              setOptions((all) => [...all, { id: nextId, name: "", price: "", available: true, opens: "" }]);
              setNextId((n) => n + 1);
            }}
          >
            <Plus size={14} /> {t("choicesEditor.addOption")}
          </Button>
        )}
      </div>

      {((tried && problem) || action.error) && <p className="text-xs text-red-600 dark:text-red-400">{action.error ?? problem}</p>}
      <p className="text-[11px] leading-relaxed text-ink-400">{t("choicesEditor.changesApply")}</p>
      <Button loading={action.busy} onClick={save} className="py-2 text-xs">
        {row ? t("choicesEditor.save") : t("choicesEditor.create")}
      </Button>
    </Card>
  );
}
