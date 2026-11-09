// Light or dark, as the person chose in Appearance: their device's theme --
// the default, followed as it changes -- or always one. Kept on <html> as a
// `light` or `dark` class, which the styles follow (index.css).
import { usePreferences, type Theme } from "../../store/preferences";

const deviceDark = typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: dark)") : null;

function apply(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && !!deviceDark?.matches);
  const root = document.documentElement;
  if (root.classList.contains("dark") === dark && root.classList.contains("light") === !dark) return;
  // All at once: without this, each control with a colour transition fades
  // on its own, and the screen ripples from one theme to the other.
  root.classList.add("theme-switching");
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
  void root.offsetHeight;
  requestAnimationFrame(() => root.classList.remove("theme-switching"));
}

/// Applies the chosen theme now, and again whenever it or the device's changes.
export function followTheme(): void {
  apply(usePreferences.getState().theme);
  usePreferences.subscribe((state, previous) => state.theme !== previous.theme && apply(state.theme));
  deviceDark?.addEventListener("change", () => apply(usePreferences.getState().theme));
}
