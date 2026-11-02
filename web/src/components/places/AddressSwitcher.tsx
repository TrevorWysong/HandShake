import { useState } from "react";
import { Check, ChevronDown, MapPin, Pencil, Plus, Trash2, X } from "lucide-react";
import { useSession } from "../../store/session";
import { saveAddress, deleteSavedAddress, listMyAddresses, updateSavedAddress } from "../../holochain/zomes/profiles";
import { bytesToHex } from "../../holochain/decode";
import { reverseGeocode } from "../../lib/places/geocoding";
import { AddressSearch } from "./AddressSearch";
import { Sheet } from "../Sheet";
import { Button, Input, SectionLabel } from "../ui";
import type { AddressComponents } from "../../lib/places/geocoding";
import type { GeoPoint, AddressDetails } from "../../holochain/types";
import { MAX_LABEL_CHARS, MAX_ADDRESS_LINE2_CHARS } from "../../holochain/types";
import { useT } from "../../i18n";
import { useResource } from "../../lib/hooks/useResource";
import { useAction } from "../../lib/hooks/useAction";

interface AddressRow {
  hash: Uint8Array;
  address: AddressDetails;
}

function cityStateZip(a: { city: string; state: string; zip: string }): string {
  const stateZip = [a.state, a.zip].filter(Boolean).join(" ");
  return [a.city, stateZip].filter(Boolean).join(", ");
}

/// The DoorDash/UberEats-style "deliver to" switcher -- a pill showing the
/// current browse/delivery location, tapping it opens a sheet to either
/// pick a saved address or search a brand new one. Deliberately decoupled
/// from `Profile`/onboarding: `location` (session.ts) is just "which
/// address am I using *right now*," independent of wherever the account
/// was first set up -- the same reasoning DoorDash's own switcher lets you
/// order for someone else at a completely different address without
/// touching your account's real home address at all.
///
/// The sheet renders through a portal onto `document.body`: inside
/// AppShell's animated route wrapper, a CSS `transform` makes that wrapper
/// the containing block for `position: fixed`, clipping the sheet to it.
///
/// `value`/`onChange` make this controllable -- omit both (Browse.tsx's
/// usage) and it drives the global browsing location in `session.ts`
/// exactly as before; pass them (Cart.tsx's per-order dropoff, which
/// should default from the session location but not need to permanently
/// change it -- ordering for someone else at a one-off address shouldn't
/// overwrite a customer's own saved "where I am" pointer) to have this
/// drive any other piece of state instead, same address book and search
/// UI either way. `onValidate` is checked before any pick (search result,
/// saved address, or manual entry) is accepted -- returning a message
/// blocks the pick and shows it inline instead of closing the sheet,
/// which is how Cart.tsx rejects a dropoff outside the merchant's own
/// delivery radius without duplicating this sheet's own pick-handling.
/// `onLine2` hears the second address line of what was picked -- a saved
/// address's own, or the one typed beside a new one.
export function AddressSwitcher({
  value,
  onChange,
  onValidate,
  onLine2,
  label: labelProp,
}: {
  value?: GeoPoint;
  onChange?: (point: GeoPoint) => void;
  onValidate?: (point: GeoPoint) => string | null;
  onLine2?: (line2: string) => void;
  label?: string;
} = {}) {
  const t = useT();
  const label = labelProp ?? t("address.choose");
  const sessionLocation = useSession((s) => s.location);
  const setSessionLocation = useSession((s) => s.setLocation);
  const location = value ?? sessionLocation;
  const setLocation = onChange ?? setSessionLocation;
  const [open, setOpen] = useState(false);
  const [addresses, setAddresses] = useState<AddressRow[] | null>(null);
  const [picked, setPicked] = useState<{ point: GeoPoint; components: AddressComponents } | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newLine2, setNewLine2] = useState("");
  // Saving, renaming or deleting an address -- one at a time.
  const action = useAction();
  /// The saved address being renamed, and its new name.
  const [renaming, setRenaming] = useState<{ hex: string; label: string } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // The pill's own display text, for wherever `location` is -- a plain
  // lat/lon means nothing to a human glancing at the header.
  const { data: current } = useResource(`reverse:${location.lat},${location.lon}`, () => reverseGeocode(location));

  function loadAddresses() {
    listMyAddresses()
      .then((views) => setAddresses(views.map((v) => ({ hash: v.original_action, address: v.address }))))
      .catch(() => setAddresses([]));
  }

  // Opening/closing is always a user action, so its side effects live in
  // the handlers rather than an effect watching `open`.
  function openSheet() {
    setOpen(true);
    loadAddresses();
  }

  function closeSheet() {
    setOpen(false);
    setValidationError(null);
  }

  function pickAddress(point: GeoPoint, line2: string) {
    const error = onValidate?.(point) ?? null;
    if (error) {
      setValidationError(error);
      return;
    }
    setValidationError(null);
    setLocation(point);
    onLine2?.(line2);
    closeSheet();
    setPicked(null);
    setNewLabel("");
    setNewLine2("");
  }

  function saveCurrentPick() {
    if (!picked || !newLabel.trim()) return;
    const [{ point, components }, label, line2] = [picked, newLabel.trim(), newLine2.trim()];
    return action.run(async () => {
      await saveAddress({ label, location: point, street: components.street, line2, city: components.city, state: components.state, zip: components.zip });
      loadAddresses();
      pickAddress(point, line2);
    }, { as: "save" });
  }

  function renameAddress(row: AddressRow) {
    const label = renaming?.label.trim();
    if (!label) return;
    return action.run(async () => {
      await updateSavedAddress(row.hash, { ...row.address, label });
      setRenaming(null);
      loadAddresses();
    }, { as: "rename" });
  }

  const removeAddress = (row: AddressRow) => action.run(async () => {
    await deleteSavedAddress(row.hash);
    loadAddresses();
  }, { as: `delete:${bytesToHex(row.hash)}` });

  // DoorDash shows just the street line in its collapsed address pill --
  // city/state/zip only shows up once you open the switcher. Falls back
  // to the full label when there's no street component to show (e.g. a
  // manually-entered lat/lon with nothing nearby to resolve a house
  // number against).
  const pillText = current?.components.street || current?.label || t("address.set");

  return (
    <>
      <button
        onClick={openSheet}
        className="mb-3 flex w-full items-center gap-2 rounded-full border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 px-4 py-2.5 text-left transition hover:border-handshake-300"
      >
        <MapPin size={16} className="shrink-0 text-handshake-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{pillText}</span>
        <ChevronDown size={16} className="shrink-0 text-ink-400" />
      </button>

      <Sheet open={open} onClose={closeSheet} title={label}>
        {current?.components.street && (
          <div className="mb-4 rounded-xl bg-handshake-50 dark:bg-handshake-900/20 p-3">
            <p className="text-[11px] font-bold uppercase tracking-wide text-handshake-600 dark:text-handshake-400">{t("address.current")}</p>
            <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{current.components.street}</p>
            <p className="text-xs text-ink-400">{cityStateZip(current.components)}</p>
          </div>
        )}

        <AddressSearch
          value={location}
          onChange={(point) => setPicked((prev) => ({ point, components: prev?.components ?? { street: "", city: "", state: "", zip: "" } }))}
          onSelectComponents={(components) => setPicked((prev) => (prev ? { ...prev, components } : null))}
          label={t("address.searchNew")}
          placeholder={t("address.enterStreet")}
        />

        {picked && (
          <div className="mt-3 flex flex-col gap-2 rounded-xl bg-ink-50 dark:bg-ink-800/50 p-3">
            <Input maxLength={MAX_ADDRESS_LINE2_CHARS} value={newLine2} onChange={(e) => setNewLine2(e.target.value)} placeholder={t("address.line2Placeholder")} autoComplete="address-line2" aria-label={t("address.line2")} />
            <div className="flex items-center gap-2">
              <Input maxLength={MAX_LABEL_CHARS} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder={t("address.labelPlaceholder")} className="flex-1" />
              <Button loading={action.doing === "save"} disabled={action.busy || !newLabel.trim()} onClick={saveCurrentPick} className="px-3 py-2.5 text-xs">
                <Plus size={14} /> {t("common.save")}
              </Button>
            </div>
          </div>
        )}
        {picked && (
          <button onClick={() => pickAddress(picked.point, newLine2.trim())} className="mt-2 text-xs font-semibold text-handshake-600 underline-offset-2 hover:underline">
            {t("address.useOnce")}
          </button>
        )}
        {(validationError ?? action.error) && <p className="mt-2 text-xs font-semibold text-red-500">{validationError ?? action.error}</p>}

        <div className="mt-5">
          <SectionLabel className="mb-2">{t("address.saved")}</SectionLabel>
          {addresses === null && <p className="text-xs text-ink-400">{t("common.loading")}</p>}
          {addresses?.length === 0 && <p className="text-xs text-ink-400">{t("address.noneSaved")}</p>}
          <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800">
            {addresses?.map((row) => {
              const hex = bytesToHex(row.hash);
              const isCurrent = location.lat === row.address.location.lat && location.lon === row.address.location.lon;
              if (renaming?.hex === hex) {
                return (
                  <div key={hex} className="flex items-center gap-2 py-3">
                    <Input autoFocus maxLength={MAX_LABEL_CHARS} value={renaming.label} onChange={(e) => setRenaming({ hex, label: e.target.value })} className="flex-1" />
                    <Button loading={action.doing === "rename"} disabled={action.busy || !renaming.label.trim()} onClick={() => renameAddress(row)} className="px-3 py-2.5 text-xs" aria-label={t("common.save")}>
                      <Check size={14} />
                    </Button>
                    <button onClick={() => setRenaming(null)} aria-label={t("common.cancel")} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800">
                      <X size={15} />
                    </button>
                  </div>
                );
              }
              return (
                <div key={hex} className="flex items-center gap-2 py-3">
                  <button onClick={() => pickAddress(row.address.location, row.address.line2)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${isCurrent ? "bg-handshake-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}>
                      <MapPin size={15} />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{row.address.label}</p>
                      <p className="truncate text-xs text-ink-400">
                        {[row.address.street, row.address.line2].filter(Boolean).join(", ")}
                        {row.address.street && ", "}
                        {cityStateZip(row.address)}
                      </p>
                    </div>
                  </button>
                  <button
                    onClick={() => setRenaming({ hex, label: row.address.label })}
                    aria-label={t("common.edit")}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-300 hover:bg-ink-100 hover:text-ink-600 dark:hover:bg-ink-800"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => removeAddress(row)}
                    disabled={action.busy}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-300 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </Sheet>
    </>
  );
}
