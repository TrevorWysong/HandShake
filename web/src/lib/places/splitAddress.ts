// An address as its split form keeps it: the street line, its second line
// (apartment, suite or unit), and its own city, state and postal code fields
// (`components/places/SplitAddressFields`).

export interface SplitAddress {
  street: string;
  /// The apartment, suite or unit -- empty when there's none.
  line2: string;
  city: string;
  state: string;
  zip: string;
}

export const EMPTY_SPLIT_ADDRESS: SplitAddress = { street: "", line2: "", city: "", state: "", zip: "" };

/// A store's address, as its catalog keeps it.
export interface CatalogAddress {
  address_street: string;
  address_line2: string;
  address_city: string;
  address_state: string;
  address_zip: string;
}

export function fromCatalogAddress(catalog: CatalogAddress): SplitAddress {
  return { street: catalog.address_street, line2: catalog.address_line2, city: catalog.address_city, state: catalog.address_state, zip: catalog.address_zip };
}

export function toCatalogAddress(address: SplitAddress): CatalogAddress {
  return { address_street: address.street, address_line2: address.line2, address_city: address.city, address_state: address.state, address_zip: address.zip };
}
