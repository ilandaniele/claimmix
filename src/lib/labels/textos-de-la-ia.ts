/**
 * Lo que escribió la IA, en la ficha y en el idioma de la cuenta.
 *
 * Los resúmenes —el del caso y el de cada adjunto— el modelo los escribe en
 * castellano: en otro idioma la ficha cae a lo que arma con los campos. Los
 * indicios del cruce de adjuntos se guardan en castellano con su `clave`, y es
 * la clave lo que se traduce.
 */

import { CLAVES_DE_DERIVADO } from "@/core/case/contradicciones";
import type { Locale, TranslationKey } from "@/lib/i18n";

const CLAVES = new Set<string>(CLAVES_DE_DERIVADO);

export function resumenDeLaIA(resumen: string | null, locale: Locale): string | null {
  return locale === "es-AR" ? resumen : null;
}

export function textoDeIndicio(
  indicio: { description: string; clave?: unknown },
  t: (key: TranslationKey) => string
): string {
  return typeof indicio.clave === "string" && CLAVES.has(indicio.clave)
    ? t(`fraude.derivado.${indicio.clave}` as TranslationKey)
    : indicio.description;
}
