// Saving something the app made -- a report, a CSV -- as a file on this device.

/// Saves `text` as `name`. Its link is let go once the browser has had time
/// to take it: let go at once, some browsers drop the download.
export function downloadText(name: string, text: string, type = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
