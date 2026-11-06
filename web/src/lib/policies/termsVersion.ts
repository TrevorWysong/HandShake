// Which terms of use are current. Kept apart from their text, so the packaging
// script can read it. Change the terms' meaning and bump this: everyone's asked
// to agree again.
export const TERMS_VERSION = "0.1";

/// Still placeholders awaiting legal review: shown as a draft in the app, and
/// no network taking live payments can be packaged while it's true
/// (`scripts/package.ts`). Set it false once counsel has finalised the text.
export const TERMS_DRAFT = true;
