// Phone numbers as people type them -- "(727) 555-0123", "0151 23456789",
// "+44 20 7946 0958" -- checked against each country's numbering plan
// (libphonenumber's, bundled: no service is asked) and kept in one
// international form, so every number reads alike and dials from anywhere.
// A number can be a real one without being in service: only a call or a
// text could tell that.
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";

/// This device's region ("US", from "en-US"), for a number typed without
/// its country code -- `undefined` where the language names none.
export function deviceRegion(): CountryCode | undefined {
  try {
    return new Intl.Locale(navigator.language).maximize().region as CountryCode | undefined;
  } catch {
    return undefined;
  }
}

/// `typed` in its international form ("+1 727 555 0123"), `""` for none,
/// or `null` if it isn't a phone number. One typed without its country
/// code is read as `region`'s.
export function normalizePhone(typed: string, region: CountryCode | undefined = deviceRegion()): string | null {
  const text = typed.trim();
  if (text === "") return "";
  const number = parsePhoneNumberFromString(text, region);
  return number?.isValid() ? number.formatInternational() : null;
}
