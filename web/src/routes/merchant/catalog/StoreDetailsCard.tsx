import { useState } from "react";
import { Globe, Mail, MapPin, Pencil, Phone } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { closeListing, detailsOf, isStoreListed, reopenListing, setAutoAcceptOrders, setBusy, setDeliverySubsidyPercent, setMaxDeliveryFee, setTipLimit, setLeaveAtDoorLimit, setMinimumOrder, updateCatalogDetails, setStoreWait } from "../../../holochain/zomes/catalog";
import { formatCatalogAddress, formatDistance, toMinorUnits, fromMinorUnits, currencySymbol, formatCents } from "../../../lib/ui/format";
import { useT } from "../../../i18n";
import { useResource } from "../../../lib/hooks/useResource";
import { useAction } from "../../../lib/hooks/useAction";
import { bytesToHex } from "../../../holochain/decode";
import { Button, Card, Field, Input, Notice, SectionLabel, Switch, Textarea } from "../../../components/ui";
import { PhotoInput } from "../../../components/PhotoInput";
import { InfoSheet } from "../../../components/InfoSheet";
import { SplitAddressFields } from "../../../components/places/SplitAddressFields";
import { fromCatalogAddress, toCatalogAddress } from "../../../lib/places/splitAddress";
import type { MerchantCatalog } from "../../../holochain/types";
import { MAX_DESCRIPTION_CHARS, MAX_EMAIL_CHARS, MAX_LABEL_CHARS, MAX_PHONE_CHARS, MAX_TIP_PERCENT, MAX_WEBSITE_CHARS } from "../../../holochain/types";
import { isStoreEmail, isStoreWebsite, normalizeWebsite, websiteLabel } from "../../../lib/storefront/contact";
import { normalizePhone } from "../../../lib/phone";
import { ScoreThreshold } from "../../../components/reputation/ScoreThreshold";
import { useTerms } from "../../../store/network";

/// The storefront's details: a read-only summary, or the editor.
export function StoreDetailsCard({ catalog, catalogRef, startEditing, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; startEditing: boolean; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(startEditing);
  const t = useT();
  return (
    <Card className="my-4 p-4">
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel>{t("storeSettings.details")}</SectionLabel>
        <button onClick={() => setEditing((v) => !v)} className="text-ink-400 hover:text-handshake-600" aria-label={t("storeSettings.editDetails")}>
          <Pencil size={14} />
        </button>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {editing ? (
          <motion.div key="edit" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <DetailsEditor
              catalog={catalog}
              onSave={async (draft) => {
                await updateCatalogDetails(catalogRef, { ...detailsOf(catalog), ...draft });
                await onSaved();
                setEditing(false);
              }}
            />
          </motion.div>
        ) : (
          <motion.div key="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-ink-600 dark:text-ink-300">
            <p>{catalog.description || t("storeSettings.noDescription")}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-400">
              {catalog.cuisine_type && <span>{catalog.cuisine_type}</span>}
              <span>{t("storeSettings.deliversWithin", { distance: formatDistance(catalog.max_delivery_radius_km) })}</span>
            </div>
            <div className="mt-3 flex flex-col gap-1.5 text-xs text-ink-500 dark:text-ink-400">
              {formatCatalogAddress(catalog) && <ContactLine icon={<MapPin size={13} />}>{formatCatalogAddress(catalog)}</ContactLine>}
              {catalog.phone && <ContactLine icon={<Phone size={13} />}>{catalog.phone}</ContactLine>}
              {catalog.email && <ContactLine icon={<Mail size={13} />}>{catalog.email}</ContactLine>}
              {catalog.website && <ContactLine icon={<Globe size={13} />}>{websiteLabel(catalog.website)}</ContactLine>}
              {!catalog.phone && !catalog.email && !catalog.website && <p className="text-ink-400">{t("storeSettings.noContact")}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

function ContactLine({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-ink-300">{icon}</span>
      <span className="truncate">{children}</span>
    </span>
  );
}

type DetailsDraft = ReturnType<typeof detailsDraftFrom>;

function detailsDraftFrom(catalog: MerchantCatalog) {
  return {
    description: catalog.description,
    cuisine_type: catalog.cuisine_type,
    banner_data_uri: catalog.banner_data_uri,
    phone: catalog.phone,
    email: catalog.email,
    website: catalog.website,
    address_street: catalog.address_street,
    address_line2: catalog.address_line2,
    address_city: catalog.address_city,
    address_state: catalog.address_state,
    address_zip: catalog.address_zip,
    max_delivery_radius_km: catalog.max_delivery_radius_km,
  };
}

/// Owns its draft, seeded from the saved details when the editor mounts --
/// so a background refresh can never overwrite an edit in progress.
function DetailsEditor({ catalog, onSave }: { catalog: MerchantCatalog; onSave: (draft: DetailsDraft) => Promise<void> }) {
  const [draft, setDraft] = useState(() => detailsDraftFrom(catalog));
  const t = useT();
  const save = useAction();
  const set = (patch: Partial<DetailsDraft>) => setDraft((d) => ({ ...d, ...patch }));
  // What validation holds a delivery radius to.
  const maxRadiusKm = useTerms().max_delivery_radius_km;
  const radiusOk = Number.isFinite(draft.max_delivery_radius_km) && draft.max_delivery_radius_km > 0 && draft.max_delivery_radius_km <= maxRadiusKm;
  const email = draft.email.trim();
  const website = normalizeWebsite(draft.website);
  const emailOk = isStoreEmail(email);
  const websiteOk = isStoreWebsite(website);
  const phone = normalizePhone(draft.phone);

  return (
    <div className="flex flex-col gap-2">
      <PhotoInput value={draft.banner_data_uri} onChange={(v) => set({ banner_data_uri: v })} shape="banner" />
      <Field label={t("storeSettings.description")}>
        <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={2} placeholder={t("storeSettings.descriptionPlaceholder")} />
      </Field>
      <Field label={t("storeSettings.cuisine")}>
        <Input maxLength={MAX_LABEL_CHARS} value={draft.cuisine_type} onChange={(e) => set({ cuisine_type: e.target.value })} placeholder={t("storeSettings.cuisinePlaceholder")} />
      </Field>
      {/* The pickup point itself can't move after publishing (see
          update_catalog_details), so only the address text is editable. */}
      <SplitAddressFields
        point={catalog.location}
        onPointChange={() => {}}
        pointIsEditable={false}
        address={fromCatalogAddress(draft)}
        onAddressChange={(a) => set(toCatalogAddress(a))}
      />
      <SectionLabel className="mt-2">{t("storeSettings.contact")}</SectionLabel>
      <p className="-mt-1 text-xs text-ink-400">{t("storeSettings.contactDetail")}</p>
      <Field label={t("profile.phone")}>
        <Input maxLength={MAX_PHONE_CHARS} value={draft.phone} onChange={(e) => set({ phone: e.target.value })} type="tel" inputMode="tel" autoComplete="tel" aria-invalid={phone === null} />
        {phone === null && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("phone.invalid")}</p>}
      </Field>
      <Field label={t("storeSettings.email")}>
        <Input maxLength={MAX_EMAIL_CHARS} value={draft.email} onChange={(e) => set({ email: e.target.value })} type="email" inputMode="email" autoComplete="email" placeholder="hello@yourstore.com" aria-invalid={!emailOk} />
        {!emailOk && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("storeSettings.emailInvalid")}</p>}
      </Field>
      <Field label={t("storeSettings.website")}>
        <Input maxLength={MAX_WEBSITE_CHARS} value={draft.website} onChange={(e) => set({ website: e.target.value })} type="url" inputMode="url" autoComplete="url" placeholder="yourstore.com" aria-invalid={!websiteOk} />
        {!websiteOk && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("storeSettings.websiteInvalid")}</p>}
      </Field>
      <Field label={t("storeSettings.radius")}>
        <Input type="number" min={0} max={maxRadiusKm} step="any" value={draft.max_delivery_radius_km} onChange={(e) => set({ max_delivery_radius_km: Number(e.target.value) })} placeholder="8" aria-invalid={!radiusOk} />
        {!radiusOk && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{t("storeSettings.radiusProblem", { max: maxRadiusKm })}</p>}
      </Field>
      <Button loading={save.busy} disabled={!emailOk || !websiteOk || !radiusOk || phone === null} onClick={() => save.run(() => onSave({ ...draft, email, website, phone: phone ?? "" }))} className="py-2 text-xs">
        {t("common.save")}
      </Button>
      {save.error && <p className="text-xs text-red-600 dark:text-red-400">{save.error}</p>}
    </div>
  );
}

/// The store's share of each delivery fee, and the most a fee may be --
/// which bounds what its share can cost.
export function DeliverySubsidyCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  return (
    <Card className="mb-4 p-4">
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1">
          <SectionLabel>{t("storeSettings.sharing")}</SectionLabel>
          <WhyLimits />
        </span>
        <button onClick={() => setEditing((v) => !v)} className="text-ink-400 hover:text-handshake-600" aria-label={t("storeSettings.editSharing")}>
          <Pencil size={14} />
        </button>
      </div>
      <p className="mb-2 text-xs text-ink-400">
        {t("storeSettings.sharingDetail")}
      </p>
      {editing ? (
        <DeliveryFeeEditor
          initialPercent={catalog.delivery_subsidy_percent}
          initialMaxCents={catalog.max_delivery_fee}
          onSave={async (percent, maxCents) => {
            if (percent !== catalog.delivery_subsidy_percent) await setDeliverySubsidyPercent(catalogRef, percent);
            if (maxCents !== catalog.max_delivery_fee) await setMaxDeliveryFee(catalogRef, maxCents);
            await onSaved();
            setEditing(false);
          }}
        />
      ) : (
        <>
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">
            {catalog.delivery_subsidy_percent > 0 ? t("storeSettings.youCover", { percent: catalog.delivery_subsidy_percent }) : t("storeSettings.customerCovers")}
          </p>
          <p className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">{t("storeSettings.feesUpTo", { amount: formatCents(catalog.max_delivery_fee) })}</p>
        </>
      )}
    </Card>
  );
}

/// How big a tip may be on the store's deliveries: a share of the order, or
/// a set amount, whichever is more. Tips pass through the store's card to
/// the driver, so this keeps what a reversed charge could cost it in
/// proportion to the order.
export function TipLimitCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  return (
    <Card className="mb-4 p-4">
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1">
          <SectionLabel>{t("storeSettings.tips")}</SectionLabel>
          <WhyLimits />
        </span>
        <button onClick={() => setEditing((v) => !v)} className="text-ink-400 hover:text-handshake-600" aria-label={t("storeSettings.editTips")}>
          <Pencil size={14} />
        </button>
      </div>
      <p className="mb-2 text-xs text-ink-400">{t("storeSettings.tipsDetail")}</p>
      {editing ? (
        <TipLimitEditor
          initialPercent={catalog.max_tip_percent}
          initialFloorCents={catalog.max_tip_floor}
          onSave={async (percent, floorCents) => {
            await setTipLimit(catalogRef, percent, floorCents);
            await onSaved();
            setEditing(false);
          }}
        />
      ) : (
        <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("storeSettings.tipsUpTo", { percent: catalog.max_tip_percent, amount: formatCents(catalog.max_tip_floor) })}</p>
      )}
    </Card>
  );
}

/// Whether the store's conductor accepts new orders by itself. It still
/// declines any priced from an outdated menu, and works with the app closed.
export function AutoAcceptCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const t = useT();
  const save = useAction();
  const toggle = (autoAccept: boolean) => save.run(async () => {
    await setAutoAcceptOrders(catalogRef, autoAccept);
    await onSaved();
  });
  return (
    <Card className="mb-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <SectionLabel className="mb-1">{t("storeSettings.autoAccept")}</SectionLabel>
          <p className="text-xs text-ink-400">{t("storeSettings.autoAcceptDetail")}</p>
        </div>
        <Switch checked={catalog.auto_accept_orders} onChange={toggle} disabled={save.busy} label={t("storeSettings.autoAccept")} />
      </div>
      {catalog.auto_accept_orders && (
        <ScoreThreshold
          label={t("storeSettings.holdBelow")}
          detail={t("storeSettings.holdBelowDetail")}
          value={catalog.hold_below_customer_score}
          disabled={save.busy}
          onChange={(hold) => save.run(async () => {
            await setAutoAcceptOrders(catalogRef, true, hold);
            await onSaved();
          })}
        />
      )}
      {save.error && <Notice className="mt-3">{save.error}</Notice>}
    </Card>
  );
}

/// The most an order may cost to be left at the door. A customer who
/// chooses the door accepts the risk once it's left; above this, the
/// store's orders are always handed over against the customer's code.
export function LeaveAtDoorCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const t = useT();
  const limit = catalog.leave_at_door_max_cents;
  return (
    <Card className="mb-4 p-4">
      <SectionLabel className="mb-1">{t("storeSettings.door")}</SectionLabel>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">{t("storeSettings.doorDetail")}</p>
      <LimitEditor key={limit ?? "none"} initialCents={limit} onSave={async (cents) => {
        await setLeaveAtDoorLimit(catalogRef, cents);
        await onSaved();
      }} />
    </Card>
  );
}

/// The smallest order the store takes, before any promo -- network
/// validation refuses a smaller one. A goodie bag is priced on its own.
export function MinimumOrderCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const t = useT();
  const minimum = catalog.min_order_cents;
  return (
    <Card className="mb-4 p-4">
      <SectionLabel className="mb-1">{t("storeSettings.minimum")}</SectionLabel>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">{t("storeSettings.minimumDetail")}</p>
      <LimitEditor key={minimum ?? "none"} initialCents={minimum} placeholder={t("policies.terms.none")} onSave={async (cents) => {
        await setMinimumOrder(catalogRef, cents);
        await onSaved();
      }} />
    </Card>
  );
}

/// How long the store may keep a checked-in driver waiting past an order's
/// ready time before they can leave paid -- its own, within the network's
/// bounds, or the network's. Customers see it at checkout; each order keeps
/// the wait it was placed under.
export function StoreWaitCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const t = useT();
  const terms = useTerms();
  const [min, max, usual] = [terms.min_store_wait_secs, terms.max_store_wait_secs, terms.store_wait_secs].map((secs) => Math.round(secs / 60));
  const own = catalog.store_wait_minutes;
  const [draft, setDraft] = useState(String(own ?? usual));
  const save = useAction();
  const minutes = Math.round(Number(draft));
  const valid = Number.isFinite(minutes) && minutes >= min && minutes <= max;
  const saveWait = (value: number | null) => save.run(async () => {
    await setStoreWait(catalogRef, value);
    await onSaved();
  });

  return (
    <Card className="mb-4 p-4">
      <SectionLabel className="mb-1">{t("storeSettings.wait")}</SectionLabel>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">
        {t("storeSettings.waitDetail")} {own === null ? t("storeSettings.usingNetwork", { minutes: usual }) : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="number" min={min} max={max} step={5} value={draft} onChange={(e) => setDraft(e.target.value)} suffix={t("storeSettings.min")} className="w-28" />
        <Button loading={save.busy} disabled={!valid || minutes === (own ?? usual)} onClick={() => saveWait(minutes)} className="px-4 py-2 text-xs">
          {t("common.save")}
        </Button>
        {own !== null && (
          <Button variant="ghost" loading={save.busy} onClick={() => saveWait(null)} className="px-4 py-2 text-xs">
            {t("storeSettings.useNetwork")}
          </Button>
        )}
      </div>
      {!valid && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{t("storeSettings.between", { min, max })}</p>}
      {save.error && <Notice className="mt-3">{save.error}</Notice>}
    </Card>
  );
}

/// Busy mode: extra minutes on the store's usual prep time while it's
/// swamped, shown to customers before they order. Off is 0.
export function BusyCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const t = useT();
  const room = useTerms().max_prep_minutes - catalog.prep_minutes;
  const busy = catalog.busy_extra_minutes > 0;
  const [draft, setDraft] = useState(String(busy ? catalog.busy_extra_minutes : Math.min(catalog.prep_minutes, room)));
  const save = useAction();
  const extra = Math.round(Number(draft));
  const valid = Number.isFinite(extra) && extra >= 1 && extra <= room;
  const saveBusy = (minutes: number) => save.run(async () => {
    await setBusy(catalogRef, minutes);
    await onSaved();
  });

  return (
    <Card className="mb-4 p-4">
      <SectionLabel className="mb-1">{t("storeSettings.busy")}</SectionLabel>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">
        {busy ? t("storeSettings.busyOn", { minutes: catalog.prep_minutes + catalog.busy_extra_minutes, usual: catalog.prep_minutes }) : t("storeSettings.busyOff")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="number" min={1} max={room} step={5} value={draft} onChange={(e) => setDraft(e.target.value)} suffix={t("storeSettings.min")} className="w-28" />
        <Button loading={save.busy} disabled={!valid || extra === catalog.busy_extra_minutes} onClick={() => saveBusy(extra)} className="px-4 py-2 text-xs">
          {busy ? t("item.update") : t("storeSettings.imBusy")}
        </Button>
        {busy && (
          <Button variant="ghost" loading={save.busy} onClick={() => saveBusy(0)} className="px-4 py-2 text-xs">
            {t("storeSettings.notBusy")}
          </Button>
        )}
      </div>
      {!valid && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{t("storeSettings.busyRange", { max: room })}</p>}
      {save.error && <Notice className="mt-3">{save.error}</Notice>}
    </Card>
  );
}

/// An amount limit, or none. Seeded from the saved limit when it mounts.
function LimitEditor({ initialCents, placeholder, onSave }: { initialCents: number | null; placeholder?: string; onSave: (cents: number | null) => Promise<void> }) {
  const t = useT();
  const [draft, setDraft] = useState(initialCents === null ? "" : String(fromMinorUnits(initialCents)));
  const save = useAction();
  const dollars = Number(draft);
  const cents = draft.trim() === "" || !Number.isFinite(dollars) || dollars <= 0 ? null : toMinorUnits(dollars);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="number" min={0} step={5} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder ?? t("storeSettings.noLimit")} prefix={currencySymbol()} className="w-32" />
        <Button loading={save.busy} disabled={cents === initialCents} onClick={() => save.run(() => onSave(cents))} className="px-4 py-2 text-xs">
          {t("common.save")}
        </Button>
      </div>
      {save.error && <Notice className="mt-3">{save.error}</Notice>}
    </div>
  );
}

/// Seeded from the saved share and most fee when it mounts.
function DeliveryFeeEditor({ initialPercent, initialMaxCents, onSave }: { initialPercent: number; initialMaxCents: number; onSave: (percent: number, maxCents: number) => Promise<void> }) {
  const t = useT();
  const [percentDraft, setPercentDraft] = useState(String(initialPercent));
  const [maxDraft, setMaxDraft] = useState(String(fromMinorUnits(initialMaxCents)));
  const save = useAction();
  const percent = Math.min(100, Math.max(0, Math.round(Number(percentDraft || 0))));
  const dollars = Number(maxDraft);
  const maxCents = Number.isFinite(dollars) && dollars > 0 ? toMinorUnits(dollars) : null;
  const unchanged = percent === initialPercent && maxCents === initialMaxCents;
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("storeSettings.yourShare")}>
          <Input type="number" min={0} max={100} step={5} value={percentDraft} onChange={(e) => setPercentDraft(e.target.value)} placeholder="50" suffix="%" className="w-24" />
        </Field>
        <Field label={t("storeSettings.mostFee")}>
          <Input type="number" min={0} step={1} value={maxDraft} onChange={(e) => setMaxDraft(e.target.value)} prefix={currencySymbol()} className="w-28" />
        </Field>
        <Button loading={save.busy} disabled={unchanged || maxCents === null} onClick={() => save.run(() => onSave(percent, maxCents!))} className="px-4 py-2 text-xs">
          {t("common.save")}
        </Button>
      </div>
      {save.error && <Notice className="mt-3">{save.error}</Notice>}
    </div>
  );
}

/// Why a store sets the most a fee and a tip can be: the trade made for a
/// checkout with one card and one payment, behind an info button beside both.
function WhyLimits() {
  const t = useT();
  const sections = (["oneCard", "passOn", "risk", "limits"] as const).map((part) => ({ title: t(`storeSettings.why.${part}`), body: t(`storeSettings.why.${part}Detail`) }));
  return <InfoSheet title={t("storeSettings.whyLimits")} sections={sections} />;
}

/// Seeded from the saved limit when it mounts.
function TipLimitEditor({ initialPercent, initialFloorCents, onSave }: { initialPercent: number; initialFloorCents: number; onSave: (percent: number, floorCents: number) => Promise<void> }) {
  const t = useT();
  const [percentDraft, setPercentDraft] = useState(String(initialPercent));
  const [floorDraft, setFloorDraft] = useState(String(fromMinorUnits(initialFloorCents)));
  const save = useAction();
  const percent = Math.min(MAX_TIP_PERCENT, Math.max(0, Math.round(Number(percentDraft || 0))));
  const dollars = Number(floorDraft || 0);
  const floorCents = Number.isFinite(dollars) && dollars >= 0 ? toMinorUnits(dollars) : null;
  const unchanged = percent === initialPercent && floorCents === initialFloorCents;
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("storeSettings.tipPercent")}>
          <Input type="number" min={0} max={MAX_TIP_PERCENT} step={10} value={percentDraft} onChange={(e) => setPercentDraft(e.target.value)} placeholder="100" suffix="%" className="w-24" />
        </Field>
        <Field label={t("storeSettings.tipFloor")}>
          <Input type="number" min={0} step={1} value={floorDraft} onChange={(e) => setFloorDraft(e.target.value)} prefix={currencySymbol()} className="w-28" />
        </Field>
        <Button loading={save.busy} disabled={unchanged || floorCents === null} onClick={() => save.run(() => onSave(percent, floorCents!))} className="px-4 py-2 text-xs">
          {t("common.save")}
        </Button>
      </div>
      {save.error && <Notice className="mt-3">{save.error}</Notice>}
    </div>
  );
}

/// Whether customers can find the store. A closed listing keeps answering
/// the orders it has; it just isn't offered to new customers.
export function ListingCard({ catalogRef }: { catalogRef: Uint8Array }) {
  const t = useT();
  const { data: listed, reload } = useResource(`store-listed:${bytesToHex(catalogRef)}`, () => isStoreListed(catalogRef));
  const [confirming, setConfirming] = useState(false);
  const save = useAction();
  const act = (change: () => Promise<void>) => save.run(async () => {
    await change();
    setConfirming(false);
    await reload();
  });

  if (listed === undefined) return null;
  return (
    <Card className="mb-4 p-4">
      <SectionLabel className="mb-1">{t("storeSettings.listing")}</SectionLabel>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">
        {listed ? t("storeSettings.listed") : t("storeSettings.unlisted")}
      </p>
      {listed ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="danger" loading={save.busy} onClick={() => act(() => closeListing(catalogRef))} className="px-4 py-2 text-xs">
              {t("storeSettings.close")}
            </Button>
            <Button variant="ghost" disabled={save.busy} onClick={() => setConfirming(false)} className="px-4 py-2 text-xs">
              {t("storeSettings.keep")}
            </Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)} className="px-4 py-2 text-xs">
            {t("storeSettings.closeEllipsis")}
          </Button>
        )
      ) : (
        <Button loading={save.busy} onClick={() => act(() => reopenListing(catalogRef))} className="px-4 py-2 text-xs">
          {t("storeSettings.listAgain")}
        </Button>
      )}
      {save.error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{save.error}</p>}
    </Card>
  );
}
