// The answers `blockCache` keeps, apart from it so the zome wrappers can
// forget them on a block or unblock without importing the reader.

export const known = new Map<string, { blocked: boolean; at: number }>();

/// Forgets every kept answer: after this device blocks or unblocks, so its
/// own change shows at once.
export function forgetBlocks(): void {
  known.clear();
}
