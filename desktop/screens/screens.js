// What every start-up screen does: shows the app's name and version, closes
// the app from its close button, and reports the node's progress as it
// starts. Kangaroo's preload (src/preload/splashscreen.ts) is all it talks
// to: `window.electronAPI`. Text is only ever set as text.
const api = window.electronAPI;

export async function showNameAndVersion() {
  const show = ({ productName, version }) => {
    for (const el of document.querySelectorAll("[data-product-name]")) el.textContent = productName;
    for (const el of document.querySelectorAll("[data-version]")) el.textContent = `Version ${version}`;
  };
  // The loading screen is told; the others ask.
  if (api.onNameAndVersion) api.onNameAndVersion((_event, info) => show(info));
  try {
    show(await api.getNameAndVersion());
  } catch {
    // Not asked for on this screen: it's told (above).
  }
}

export function closeButton() {
  document.getElementById("close").addEventListener("click", () => api.exit());
}

/// Shows one step of the screen, and focuses what's first to fill in.
export function showStep(id) {
  for (const step of document.querySelectorAll(".step")) step.hidden = step.id !== id;
  document.querySelector(`#${id} input:not([type=checkbox])`)?.focus();
}

/// Starts the node: the progress step while it does, its messages as they come.
export async function launch(passwordInput) {
  showStep("starting");
  return api.launch(passwordInput);
}

export function followProgress() {
  const message = document.getElementById("progress-message");
  api.onProgressUpdate((_event, text) => {
    message.textContent = String(text);
  });
}

/// The "Show" toggle beside a password field.
export function revealToggles() {
  for (const toggle of document.querySelectorAll("[data-reveals]")) {
    const input = document.getElementById(toggle.dataset.reveals);
    toggle.addEventListener("click", () => {
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      toggle.textContent = hidden ? "Hide" : "Show";
      toggle.setAttribute("aria-pressed", String(hidden));
      input.focus();
    });
  }
}
