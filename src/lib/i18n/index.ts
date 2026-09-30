/**
 * i18n helper — typed translation function supporting es-AR and en-US.
 *
 * Usage in Server Components:
 *   import { getT } from '@/lib/i18n';
 *   import { getAccountLocale } from '@/server/i18n/idioma-de-la-cuenta';
 *   const locale = await getAccountLocale();
 *   const t = getT(locale);
 *   <h1>{t('nav.bandeja')}</h1>
 *
 * Usage in Client Components:
 *   import { useT } from '@/lib/i18n/LocaleContext';
 *   const t = useT();
 *   <h1>{t('nav.bandeja')}</h1>
 *
 * Backwards-compatible: t(key) still works and defaults to es-AR.
 *
 * Este módulo junta los dos diccionarios (cliente y servidor) y es sólo para
 * código de servidor: si un componente de cliente lo importa, el navegador se
 * baja también los textos que nunca pinta. Los de cliente usan LocaleContext.
 */

import { esAR as esARCliente, type ClaveDelCliente } from "./es-AR";
import { esARServidor, type ClaveDelServidor } from "./es-AR.servidor";
import { enUS as enUSCliente } from "./en-US";
import { enUSServidor } from "./en-US.servidor";

export type Locale = "es-AR" | "en-US";

export type TranslationKey = ClaveDelCliente | ClaveDelServidor;

const esAR = { ...esARCliente, ...esARServidor };
const enUS = { ...enUSCliente, ...enUSServidor };

const TRANSLATIONS: Record<Locale, Record<TranslationKey, string>> = {
  "es-AR": esAR,
  "en-US": enUS,
};

/** Translate a single key with the given locale (defaults to es-AR). */
export function t(key: TranslationKey, locale: Locale = "es-AR"): string {
  return TRANSLATIONS[locale]?.[key] ?? esAR[key];
}

/** Return a locale-bound translation function — use in Server Components to avoid passing locale to every call. */
export function getT(locale: Locale): (key: TranslationKey) => string {
  const map = TRANSLATIONS[locale] ?? esAR;
  return (key: TranslationKey) => map[key] ?? esAR[key];
}

// Re-export for consumers that need the raw maps or types.
export { esAR, enUS, type ClaveDelCliente, type ClaveDelServidor };
