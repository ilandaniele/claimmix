/**
 * i18n helper — typed translation function for es-AR strings.
 *
 * Usage:
 *   import { t } from '@/lib/i18n';
 *   <h1>{t('nav.bandeja')}</h1>
 *
 * The function is intentionally trivial — it's a typed wrapper around the
 * flat string map. No runtime overhead, no framework needed (IC7: single locale).
 */

import { esAR, type TranslationKey } from "./es-AR";

/**
 * Translate a key to its es-AR string value.
 * TypeScript will error at compile time if the key doesn't exist.
 */
export function t(key: TranslationKey): string {
  return esAR[key];
}

// Re-export the raw map and type for use cases that need direct access.
export { esAR, type TranslationKey };
