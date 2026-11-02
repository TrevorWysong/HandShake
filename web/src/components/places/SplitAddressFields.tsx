import { Field, Input } from "../ui";
import { AddressSearch } from "./AddressSearch";
import type { GeoPoint } from "../../holochain/types";
import { MAX_PLACE_CHARS, MAX_POSTAL_CODE_CHARS, MAX_ADDRESS_LINE2_CHARS } from "../../holochain/types";
import { useT } from "../../i18n";
import type { SplitAddress } from "../../lib/places/splitAddress";

/// One live search box for the street line (fills every field below in
/// one tap) plus plain, directly-editable City/State/Postal code fields --
/// the same pattern Stripe/Shopify/Google Pay's own address forms use.
/// Shared by every "enter an address" moment in the app (user
/// registration, a merchant's own pickup location, editing a storefront's
/// details afterward) so this looks and behaves identically everywhere,
/// rather than three screens each inventing their own address UI.
///
/// Works for any country out of the box: the free search underneath
/// (Nominatim/OSM) isn't US-only, and State/ZIP are always plain text
/// here, never a hardcoded "pick from 50 US states" dropdown -- that's
/// the thing that would actually break outside the US.
export function SplitAddressFields({
  point,
  onPointChange,
  address,
  onAddressChange,
  pointIsEditable = true,
  streetLabel,
  withLine2 = true,
}: {
  point: GeoPoint;
  onPointChange: (p: GeoPoint) => void;
  address: SplitAddress;
  onAddressChange: (a: SplitAddress) => void;
  /// Off when `point` is immutable and editing it here wouldn't do
  /// anything real -- e.g. a merchant's storefront pickup location, fixed
  /// forever at publish time. Turns off AddressSearch's own "enter
  /// coordinates manually" escape hatch and its "update the location"
  /// warning, neither of which would make sense on a box that isn't
  /// actually driving a real, saved coordinate.
  pointIsEditable?: boolean;
  streetLabel?: string;
  /// Off where an address only says where someone is (onboarding's area to
  /// browse), not where to come to: there's no door to find.
  withLine2?: boolean;
}) {
  const t = useT();
  return (
    <>
      <AddressSearch
        value={point}
        onChange={onPointChange}
        // A search finds the building, never the unit: what's typed stays.
        onSelectComponents={(c) => onAddressChange({ ...address, street: c.street, city: c.city, state: c.state, zip: c.zip })}
        label={streetLabel ?? t("address.street")}
        placeholder={t("address.search")}
        displayAfterSelect="street"
        allowManualCoordinates={pointIsEditable}
        showLocationWarning={pointIsEditable}
        initialQuery={address.street}
      />
      {withLine2 && <AddressLine2Field value={address.line2} onChange={(line2) => onAddressChange({ ...address, line2 })} />}
      <Field label={t("address.city")}>
        <Input maxLength={MAX_PLACE_CHARS} value={address.city} onChange={(e) => onAddressChange({ ...address, city: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("address.region")}>
          <Input maxLength={MAX_PLACE_CHARS} value={address.state} onChange={(e) => onAddressChange({ ...address, state: e.target.value })} />
        </Field>
        <Field label={t("address.postalCode")}>
          <Input maxLength={MAX_POSTAL_CODE_CHARS} value={address.zip} onChange={(e) => onAddressChange({ ...address, zip: e.target.value })} />
        </Field>
      </div>
    </>
  );
}

/// An address's second line: the apartment, suite or unit, if any.
export function AddressLine2Field({ value, onChange }: { value: string; onChange: (line2: string) => void }) {
  const t = useT();
  return (
    <Field label={t("address.line2")}>
      <Input maxLength={MAX_ADDRESS_LINE2_CHARS} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t("address.line2Placeholder")} autoComplete="address-line2" />
    </Field>
  );
}
