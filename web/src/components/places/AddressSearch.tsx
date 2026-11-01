import { useState } from "react";
import { ArrowRight, MapPin, Search } from "lucide-react";
import clsx from "clsx";
import { Input, Spinner } from "./ui";
import { searchAddress, reverseGeocode } from "../lib/places/geocoding";
import type { GeoPoint } from "../holochain/types";
import type { AddressComponents, GeocodeResult } from "../lib/places/geocoding";
import { useT } from "../i18n";
import { useResource } from "../lib/hooks/useResource";

// A search runs when the person asks for one -- Enter, or the button --
// never as they type: the geocoder's usage policy forbids search-as-you-type
// (Nominatim's allows one request a second for the whole app), and each
// search tells it roughly where someone is. It's a `useResource` keyed by
// what was searched for, so a slow reply for an earlier search never
// replaces a later one, and nothing lands after the box is gone.

export function AddressSearch({
  value,
  onChange,
  onSelectComponents,
  label: labelProp,
  placeholder: placeholderProp,
  displayAfterSelect = "label",
  allowManualCoordinates = true,
  showLocationWarning = true,
  initialQuery,
}: {
  value: GeoPoint;
  onChange: (v: GeoPoint) => void;
  /// Fired alongside `onChange` whenever a search result is actually
  /// picked (never on a manual lat/lon entry, which has no address
  /// components to offer) -- lets a caller prefill a split address form
  /// (street/city/state/zip) from the same selection in one tap, instead
  /// of a customer/merchant having to type the same address twice. The
  /// caller decides which of the returned components to actually apply --
  /// e.g. a city-only search box passes just `city`/`state` through and
  /// leaves `street`/`zip` untouched, since picking a city-level result
  /// shouldn't blank out an already-filled street address.
  onSelectComponents?: (c: AddressComponents) => void;
  label?: string;
  placeholder?: string;
  /// What to leave showing in the box after a result is picked. `"label"`
  /// (default) shows the full formatted address -- right for a field that
  /// genuinely represents one whole address (delivery/pickup location).
  /// `"street"` shows just the street portion instead, for a box that's
  /// paired with its own separate city/state/zip fields right below it --
  /// showing the full label there would just restate what those other
  /// fields already say.
  displayAfterSelect?: "label" | "street";
  /// Off for a box that drives other fields rather than representing a
  /// real, independently-meaningful coordinate itself -- letting someone
  /// punch in raw lat/lon there wouldn't mean anything.
  allowManualCoordinates?: boolean;
  /// Off for the same case -- the warning's own wording ("update the
  /// location") only makes sense for a box that actually owns a location.
  showLocationWarning?: boolean;
  /// Seeds the box with already-known text instead of leaving it blank
  /// or reverse-geocoding `value` -- for a component-scoped box
  /// (`displayAfterSelect="street"`) whose caller already has the real
  /// saved text (e.g. a catalog's own `address_street`) sitting right
  /// there, so there's nothing to derive from `value` at all. Only read
  /// once, on mount -- this is a seed for the box's own internal typing
  /// state, not a controlled value kept in sync on every render.
  initialQuery?: string;
}) {
  const t = useT();
  const label = labelProp ?? t("store.deliveryLocation");
  const placeholder = placeholderProp ?? t("address.search");
  /// What the person typed (or picked), once they have: until then the box
  /// shows `initialQuery`, or the address looked up for `value`.
  const [typed, setTyped] = useState<string | null>(initialQuery || null);
  /// The search asked for -- `null` before one, and again once the person
  /// types on from it. Numbered, so asking again (after a failure) searches
  /// again.
  const [searched, setSearched] = useState<{ text: string; attempt: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  // Tracks whether `query` (what's visibly typed) actually corresponds to
  // `value` (what gets submitted) -- typing without ever picking a result
  // leaves `value` at whatever it was before, which is the safe behavior,
  // but silently: the box can show garbage text while the real location
  // underneath is still the old, valid one. Surfaced so that's not hidden.
  const [confirmed, setConfirmed] = useState(true);

  // If we already have coordinates (editing an existing address) but no
  // label yet, look one up so the field doesn't just show blank next to a
  // real location -- until the person types. Skipped for a
  // component-scoped box (`displayAfterSelect="street"`): `value` there is
  // just whatever GeoPoint the caller had lying around (often the whole
  // storefront's own immutable pickup point), not something this
  // particular box represents, so reverse-geocoding it into a full address
  // label would show the wrong thing before anyone's even touched the box.
  const lookUp = displayAfterSelect === "label" && !initialQuery && typed === null;
  const { data: lookedUp } = useResource(lookUp ? `reverse:${value.lat},${value.lon}` : null, () => reverseGeocode(value));
  const query = typed ?? lookedUp?.label ?? "";
  const { data: results, error: searchError } = useResource(searched && `address-search:${searched.attempt}:${searched.text}`, () => searchAddress(searched!.text));
  const searching = searched !== null && results === undefined && !searchError;

  function type(text: string) {
    setTyped(text);
    setConfirmed(false);
    setSearched(null);
    setOpen(false);
  }

  function search() {
    const text = query.trim();
    if (!text) return;
    setSearched((prev) => ({ text, attempt: (prev?.attempt ?? 0) + 1 }));
    setOpen(true);
  }

  function selectResult(result: GeocodeResult) {
    onChange(result.point);
    onSelectComponents?.(result.components);
    setTyped(displayAfterSelect === "street" ? result.components.street || result.label : result.label);
    setConfirmed(true);
    setSearched(null);
    setOpen(false);
  }

  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-ink-500">{label}</p>
      {!manual ? (
        <div className="relative">
          <div className="relative flex items-center">
            <Search size={15} className="pointer-events-none absolute left-3.5 text-ink-400" />
            <Input
              value={query}
              onChange={(e) => type(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                // A search, not the form around the box.
                e.preventDefault();
                search();
              }}
              onFocus={() => results && setOpen(true)}
              // A result keeps the focus as it's pressed (below), so a blur
              // is always leaving the box.
              onBlur={() => setOpen(false)}
              placeholder={placeholder}
              enterKeyHint="search"
              className="pl-9 pr-11"
            />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={search}
              disabled={!query.trim() || searching}
              aria-label={t("address.searchButton")}
              className="absolute right-1.5 grid h-8 w-8 place-items-center rounded-lg text-handshake-600 transition-colors hover:bg-handshake-50 disabled:text-ink-300 disabled:hover:bg-transparent dark:hover:bg-handshake-900/30"
            >
              {searching ? <Spinner className="h-4 w-4" /> : <ArrowRight size={16} />}
            </button>
          </div>
          {showLocationWarning && !confirmed && !open && query.trim() && (
            <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">{t("address.pickBelow")}</p>
          )}
          {open && searched !== null && !searching && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-ink-200/70 dark:border-ink-700/70 bg-white dark:bg-ink-900 shadow-lg">
              {(results ?? []).length === 0 && <p className="px-3.5 py-2.5 text-xs text-ink-400">{searchError ? t("address.searchError") : t("address.noMatches")}</p>}
              {(results ?? []).map((result, i) => (
                <button
                  key={`${result.point.lat},${result.point.lon}:${result.label}`}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectResult(result)}
                  className={clsx(
                    "flex w-full items-start gap-2 px-3.5 py-2.5 text-left text-xs text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800",
                    i > 0 && "border-t border-ink-100 dark:border-ink-800",
                  )}
                >
                  <MapPin size={14} className="mt-0.5 shrink-0 text-handshake-500" />
                  <span>{result.label}</span>
                </button>
              ))}
            </div>
          )}
          {allowManualCoordinates && (
            <button type="button" onClick={() => setManual(true)} className="mt-1.5 text-[11px] font-medium text-ink-400 underline-offset-2 hover:text-handshake-600 hover:underline">
              {t("address.manual")}
            </button>
          )}
        </div>
      ) : (
        <div>
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-ink-400">
              {t("address.latitude")}
              <Input type="number" step="any" value={value.lat} onChange={(e) => onChange({ ...value, lat: Number(e.target.value) })} className="mt-1" />
            </label>
            <label className="flex-1 text-xs text-ink-400">
              {t("address.longitude")}
              <Input type="number" step="any" value={value.lon} onChange={(e) => onChange({ ...value, lon: Number(e.target.value) })} className="mt-1" />
            </label>
          </div>
          <button type="button" onClick={() => setManual(false)} className="mt-1.5 text-[11px] font-medium text-ink-400 underline-offset-2 hover:text-handshake-600 hover:underline">
            {t("address.byAddress")}
          </button>
        </div>
      )}
    </div>
  );
}
