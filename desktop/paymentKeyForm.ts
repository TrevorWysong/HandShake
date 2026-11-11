// What the key window (desktop/paymentKeys.ts) and its page's preload
// (desktop/paymentKeysPreload.ts) share: the channel between them, the form
// the window asks for, and its words. Imported by both, so neither can
// drift from the other.

/// The one IPC channel the key window's page speaks on.
export const KEY_CHANNEL = 'handshake-payment-keys';

/// The processors whose keys are typed: the test processor needs none.
export type KeyedProcessor = 'Stripe' | 'Square';

export type Locale = 'en' | 'es';

export interface KeyField {
  /// The agent's name for it (`payments/src/adapters`, `KEY_NAMES`).
  name: string;
  label: string;
  placeholder: string;
  /// Hidden as it's typed, until shown.
  secret: boolean;
}

/// What the window's page draws: everything it says, already in the
/// person's language.
export interface KeyForm {
  locale: Locale;
  title: string;
  intro: string;
  fields: KeyField[];
  connect: string;
  checking: string;
  cancel: string;
  show: string;
  hide: string;
  stays: string;
}

/// The page's answer: the keys, or that the person changed their mind.
export type KeyAnswer = { keys: Record<string, string> } | { cancel: true };

const FIELDS: Record<KeyedProcessor, { name: string; label: keyof Words; placeholder: string; secret: boolean }[]> = {
  Stripe: [
    { name: 'publishable_key', label: 'publishable', placeholder: 'pk_…', secret: false },
    { name: 'restricted_key', label: 'restricted', placeholder: 'rk_…', secret: true },
  ],
  Square: [
    { name: 'application_id', label: 'applicationId', placeholder: 'sq0idp-…', secret: false },
    { name: 'location_id', label: 'locationId', placeholder: 'L…', secret: false },
    { name: 'access_token', label: 'accessToken', placeholder: 'EAAA…', secret: true },
  ],
};

interface Words {
  title: string;
  intro: string;
  connect: string;
  checking: string;
  cancel: string;
  show: string;
  hide: string;
  stays: string;
  publishable: string;
  restricted: string;
  applicationId: string;
  locationId: string;
  accessToken: string;
  // The main process's own dialogs (desktop/payments.ts).
  confirmConnect: string;
  confirmConnectDetail: string;
  confirmConnectYes: string;
  confirmDisconnect: string;
  confirmDisconnectDetail: string;
  confirmDisconnectYes: string;
  live: string;
  test: string;
}

export const WORDS: Record<Locale, Words> = {
  en: {
    title: 'Your {processor} keys',
    intro: 'Paste the keys from your {processor} dashboard. This is HandShake\'s own window: the app\'s pages never see what you type here.',
    connect: 'Connect {processor}',
    checking: 'Checking with {processor}…',
    cancel: 'Cancel',
    show: 'Show',
    hide: 'Hide',
    stays: 'Your keys stay on this device, sealed in its keystore. They never go on the network, and you can revoke them from your processor\'s dashboard at any time.',
    publishable: 'Publishable key',
    restricted: 'Restricted key',
    applicationId: 'Application ID',
    locationId: 'Location ID',
    accessToken: 'Access token',
    confirmConnect: 'Get paid into this {processor} account?',
    confirmConnectDetail: '{account} ({mode}). Customers\' and stores\' cards will be held and charged for you on it.',
    confirmConnectYes: 'Connect',
    confirmDisconnect: 'Stop taking card payments here?',
    confirmDisconnectDetail: 'Payments this account holds are collected only once it\'s connected again. Until then nobody can pay you by card.',
    confirmDisconnectYes: 'Disconnect',
    live: 'live',
    test: 'test mode',
  },
  es: {
    title: 'Tus claves de {processor}',
    intro: 'Pega las claves del panel de {processor}. Esta es una ventana propia de HandShake: las páginas de la app nunca ven lo que escribes aquí.',
    connect: 'Conectar {processor}',
    checking: 'Comprobando con {processor}…',
    cancel: 'Cancelar',
    show: 'Mostrar',
    hide: 'Ocultar',
    stays: 'Tus claves se quedan en este dispositivo, selladas en su almacén de claves. Nunca van a la red, y puedes revocarlas desde el panel de tu procesador cuando quieras.',
    publishable: 'Clave publicable',
    restricted: 'Clave restringida',
    applicationId: 'ID de aplicación',
    locationId: 'ID de ubicación',
    accessToken: 'Token de acceso',
    confirmConnect: '¿Cobrar en esta cuenta de {processor}?',
    confirmConnectDetail: '{account} ({mode}). Las tarjetas de clientes y tiendas se retendrán y cobrarán para ti en ella.',
    confirmConnectYes: 'Conectar',
    confirmDisconnect: '¿Dejar de aceptar pagos con tarjeta aquí?',
    confirmDisconnectDetail: 'Lo que retiene esta cuenta solo se cobra cuando vuelvas a conectarla. Hasta entonces nadie puede pagarte con tarjeta.',
    confirmDisconnectYes: 'Desconectar',
    live: 'real',
    test: 'modo de prueba',
  },
};

/// `text` with its `{names}` filled.
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/// The person's language, from what the app says it's in: Spanish, or English.
export const localeOf = (value: unknown): Locale => (value === 'es' ? 'es' : 'en');

/// Whether `processor` is one whose keys are typed.
export const isKeyed = (processor: unknown): processor is KeyedProcessor => processor === 'Stripe' || processor === 'Square';

/// The form for `processor`'s keys, in `locale`.
export function keyForm(processor: KeyedProcessor, locale: Locale): KeyForm {
  const words = WORDS[locale];
  const named = (text: string) => fill(text, { processor });
  return {
    locale,
    title: named(words.title),
    intro: named(words.intro),
    fields: FIELDS[processor].map((field) => ({ name: field.name, label: words[field.label], placeholder: field.placeholder, secret: field.secret })),
    connect: named(words.connect),
    checking: named(words.checking),
    cancel: words.cancel,
    show: words.show,
    hide: words.hide,
    stays: words.stays,
  };
}
