import { useState } from "react";
import { Gift, PackageOpen, Pencil, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { createGoodieBag, listGoodieBagsForCatalog, updateGoodieBag } from "../../../holochain/zomes/catalog";
import { bagStandings } from "../../../holochain/zomes/dispatch";
import { bytesToHex, decodeEntry, hexToBytes } from "../../../holochain/decode";
import { useResource } from "../../../lib/hooks/useResource";
import { formatCents, formatClockTime, toMinorUnits, currencySymbol, toLocalDateTime } from "../../../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../../../lib/ui/motion";
import { Button, Card, Checkbox, Field, GroupHeading, Input, Notice, StatNumber, Textarea } from "../../../components/ui";
import { PhotoInput } from "../../../components/PhotoInput";
import { AllergenFactsEditor } from "../../../components/store/AllergenFactsEditor";
import type { AllergenFacts, GoodieBag } from "../../../holochain/types";
import { POLL } from "../../../lib/network/poll";
import { useTerms } from "../../../store/network";
import { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS } from "../../../holochain/types";
import { appLocale, useT } from "../../../i18n";
import { useAction } from "../../../lib/hooks/useAction";

const DAY_MS = 24 * 60 * 60 * 1000;

/// The store's live bags, each with how many are left -- sold as the store
/// accepts orders with them.
async function fetchBags(catalogRef: Uint8Array): Promise<{ hex: string; bag: GoodieBag; left: number }[]> {
  const views = await listGoodieBagsForCatalog(catalogRef);
  const standings = await bagStandings(views.map((v) => v.original_action));
  return views.map((v, i) => ({ hex: bytesToHex(v.original_action), bag: decodeEntry<GoodieBag>(v.record), left: standings[i]?.left ?? 0 }));
}

/// The store's live goodie bags and a form to list a new one. Orders with
/// a bag come in with the store's other orders -- polled, since accepting
/// them sells bags.
export function GoodieBagsSection({ storeHex, catalogRef }: { storeHex: string; catalogRef: Uint8Array }) {
  const t = useT();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const { data, reload } = useResource(`store-bags:${storeHex}`, () => fetchBags(catalogRef), { pollMs: POLL.signalled, refreshOn: () => true });
  const bags = data ?? [];

  return (
    <section className="mb-6">
      <motion.div variants={fadeSlideUp}>
        <GroupHeading
          icon={Gift}
          title={t("bags.title")}
          className="mb-3"
          action={
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setShowForm((v) => !v)}>
              {showForm ? <X size={14} /> : <PackageOpen size={14} />} {showForm ? t("common.cancel") : t("bags.add")}
            </Button>
          }
        />
      </motion.div>

      <AnimatePresence initial={false}>
        {showForm && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <NewBagForm
              catalogRef={catalogRef}
              onCreated={async () => {
                setShowForm(false);
                await reload();
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {data && bags.length === 0 && !showForm ? (
        <p className="rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 text-center text-sm text-ink-400">{t("bags.none")}</p>
      ) : (
        <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
          {bags.map(({ hex, bag, left }) =>
            editing === hex ? (
              <EditBagForm
                key={hex}
                original={hexToBytes(hex)}
                bag={bag}
                onDone={async (saved) => {
                  setEditing(null);
                  if (saved) await reload();
                }}
              />
            ) : (
            <motion.div key={hex} variants={fadeSlideUp} className="flex items-center gap-3 p-4">
              {bag.photo_data_uri && <img src={bag.photo_data_uri} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{bag.title}</p>
                <p className="text-xs text-ink-400">
                  {new Date(bag.pickup_window_start / 1000).toLocaleString(appLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} –{" "}
                  {formatClockTime(bag.pickup_window_end)} · {t("bags.left", { left, count: bag.quantity_total })}
                </p>
                <div className="flex items-center gap-2">
                  <StatNumber className="text-sm">{formatCents(bag.price_cents)}</StatNumber>
                  <span className="text-xs text-ink-400 line-through">{formatCents(bag.original_value_cents)}</span>
                </div>
              </div>
              <Button variant="ghost" className="px-2 py-1.5 text-xs" aria-label={t("common.edit")} onClick={() => setEditing(hex)}>
                <Pencil size={14} />
              </Button>
            </motion.div>
            ),
          )}
        </motion.div>
      )}

    </section>
  );
}

/// A listed bag's words and photo, edited in place -- all of it a bag may
/// change once listed; its price, quantity and window stay as customers
/// first saw them.
function EditBagForm({ original, bag, onDone }: { original: Uint8Array; bag: GoodieBag; onDone: (saved: boolean) => Promise<void> }) {
  const t = useT();
  const [form, setForm] = useState({ title: bag.title, description: bag.description, photo_data_uri: bag.photo_data_uri, allergens: bag.allergens ?? null });
  const save = useAction();

  // Done moves on from the form: it stays busy until it does.
  const update = () => save.run(async () => {
    await updateGoodieBag(original, { ...bag, allergens: form.allergens, title: form.title.trim(), description: form.description, photo_data_uri: form.photo_data_uri });
    await onDone(true);
  }, { stayBusy: true });

  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex gap-3">
        <PhotoInput value={form.photo_data_uri} onChange={(v) => setForm((f) => ({ ...f, photo_data_uri: v }))} shape="circle" className="shrink-0" />
        <Field label={t("bags.name")} className="flex-1">
          <Input maxLength={MAX_NAME_CHARS} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        </Field>
      </div>
      <Field label={t("storeSettings.description")}>
        <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
      </Field>
      <AllergenFactsEditor value={form.allergens} onChange={(allergens) => setForm((f) => ({ ...f, allergens }))} unstatedDetail="bags.allergensVary" />
      <p className="text-[11px] text-ink-400">{t("bags.fixed")}</p>
      {save.error && <p className="text-xs text-red-600 dark:text-red-400">{save.error}</p>}
      <div className="flex gap-2">
        <Button variant="ghost" className="flex-1 py-2 text-xs" disabled={save.busy} onClick={() => onDone(false)}>
          {t("common.cancel")}
        </Button>
        <Button className="flex-1 py-2 text-xs" loading={save.busy} disabled={!form.title.trim()} onClick={update}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/// Seeded once on mount with a window starting in an hour and lasting two.
function NewBagForm({ catalogRef, onCreated }: { catalogRef: Uint8Array; onCreated: () => Promise<void> }) {
  const t = useT();
  // The longest a bag may stay listed -- validation refuses longer.
  const { goodie_bag_max_days: maxDays } = useTerms();
  const [form, setForm] = useState(() => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    return {
      title: "",
      description: "",
      photo_data_uri: "",
      allergens: null as AllergenFacts | null,
      originalValue: 15,
      price: 5,
      quantity_total: 3,
      start: toLocalDateTime(start.getTime() * 1000),
      end: toLocalDateTime((start.getTime() + 2 * 60 * 60 * 1000) * 1000),
      supports_pickup: true,
      supports_delivery: false,
    };
  });
  const save = useAction();
  // When the form opened -- close enough to "when it's listed" for the
  // 7-day check, and read once rather than on every render.
  const [openedAt] = useState(() => Date.now());
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const startMs = new Date(form.start).getTime();
  const endMs = new Date(form.end).getTime();
  // The same rules validation enforces, surfaced before the round trip.
  const problem =
    !form.title.trim()
      ? t("bags.problem.name")
      : form.price <= 0 || form.price > form.originalValue
        ? t("bags.problem.price")
        : !Number.isInteger(form.quantity_total) || form.quantity_total < 1
          ? t("bags.problem.quantity")
          : !form.supports_pickup && !form.supports_delivery
            ? t("bags.problem.fulfillment")
            : !(endMs > startMs) || endMs <= openedAt
              ? t("bags.problem.window")
              : endMs - openedAt > maxDays * DAY_MS
                ? t("bags.problem.tooLong", { count: maxDays })
                : null;

  const list = () => save.run(async () => {
    await createGoodieBag({
      catalog_ref: catalogRef,
      title: form.title.trim(),
      description: form.description,
      photo_data_uri: form.photo_data_uri,
      allergens: form.allergens,
      original_value_cents: toMinorUnits(form.originalValue),
      price_cents: toMinorUnits(form.price),
      quantity_total: form.quantity_total,
      pickup_window_start: startMs * 1000,
      pickup_window_end: endMs * 1000,
      supports_pickup: form.supports_pickup,
      supports_delivery: form.supports_delivery,
    });
    await onCreated();
  });

  return (
    <Card className="mb-4 flex flex-col gap-2 p-4">
      <div className="flex gap-3">
        <PhotoInput value={form.photo_data_uri} onChange={(v) => set({ photo_data_uri: v })} shape="circle" className="shrink-0" />
        <div className="flex flex-1 flex-col gap-2">
          <Field label={t("bags.name")}>
            <Input maxLength={MAX_NAME_CHARS} value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder={t("bags.namePlaceholder")} />
          </Field>
          <div className="flex gap-2">
            <Field label={t("bags.value")}>
              <Input type="number" min={0} step={0.5} value={form.originalValue} onChange={(e) => set({ originalValue: Number(e.target.value) })} prefix={currencySymbol()} />
            </Field>
            <Field label={t("bags.price")}>
              <Input type="number" min={0} step={0.5} value={form.price} onChange={(e) => set({ price: Number(e.target.value) })} prefix={currencySymbol()} />
            </Field>
          </div>
        </div>
      </div>
      <Field label={t("storeSettings.description")}>
        <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2} placeholder={t("bags.descriptionPlaceholder")} />
      </Field>
      <AllergenFactsEditor value={form.allergens} onChange={(allergens) => set({ allergens })} unstatedDetail="bags.allergensVary" />
      <Field label={t("bags.quantity")}>
        <Input type="number" min={1} step={1} value={form.quantity_total} onChange={(e) => set({ quantity_total: Number(e.target.value) })} className="w-32" />
      </Field>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Field label={t("bags.windowStart")} className="min-w-0 flex-1">
          <Input type="datetime-local" value={form.start} onChange={(e) => set({ start: e.target.value })} />
        </Field>
        <Field label={t("bags.windowEnd")} className="min-w-0 flex-1">
          <Input type="datetime-local" value={form.end} onChange={(e) => set({ end: e.target.value })} />
        </Field>
      </div>
      <p className="text-[11px] text-ink-400">{t("bags.fixed")}</p>
      <div className="flex gap-4 pt-1">
        <label className="flex items-center gap-2 text-xs text-ink-500">
          <Checkbox checked={form.supports_pickup} onChange={(e) => set({ supports_pickup: e.target.checked })} />
          {t("bags.offerPickup")}
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-500">
          <Checkbox checked={form.supports_delivery} onChange={(e) => set({ supports_delivery: e.target.checked })} />
          {t("bags.offerDelivery")}
        </label>
      </div>
      {problem && form.title.trim() && <p className="text-xs text-amber-600 dark:text-amber-400">{problem}</p>}
      {save.error && <Notice>{save.error}</Notice>}
      <Button loading={save.busy} disabled={!!problem} onClick={list} className="py-2.5 text-xs">
        {t("bags.list")}
      </Button>
    </Card>
  );
}
