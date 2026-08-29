/**
 * Los estados y los tipos de siniestro, con su etiqueta, derivados del esquema.
 *
 * Acá NO hay ninguna etiqueta escrita. Las palabras viven en el diccionario
 * i18n, que ya las tiene completas en los dos idiomas; esto sólo recorre el
 * enum de Zod y le pide a `t` la que corresponde.
 *
 * Existe porque estaban copiadas a mano en tres pantallas y las tres se
 * quedaron atrás: `analisis` ofrecía cinco estados de trece y cuatro tipos de
 * nueve, así que no se podía filtrar por cristales, responsabilidad civil, robo
 * de contenido ni accidente personal — los chips existían en otra pantalla pero
 * el desplegable de análisis no los tenía.
 *
 * Derivar del enum en vez de copiar significa que agregar un tipo de siniestro
 * al esquema lo hace aparecer en todas las pantallas sin tocar ninguna. Que era
 * justamente lo que no pasaba.
 */

import { t, type Locale } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/es-AR";
import {
  CaseStatusSchema,
  ClaimTypeSchema,
  type CaseStatus,
  type ClaimType,
} from "@/lib/schemas/cases";

/** Todos los estados, en el orden del esquema, con su etiqueta. */
export function statusOptions(locale: Locale = "es-AR"): Array<{
  value: CaseStatus;
  label: string;
}> {
  return CaseStatusSchema.options.map((value) => ({
    value,
    label: t(`status.${value}` as TranslationKey, locale),
  }));
}

/** Todos los tipos de siniestro, en el orden del esquema, con su etiqueta. */
export function claimTypeOptions(locale: Locale = "es-AR"): Array<{
  value: ClaimType;
  label: string;
}> {
  return ClaimTypeSchema.options.map((value) => ({
    value,
    label: t(`type.${value}` as TranslationKey, locale),
  }));
}

/** El mapa, para cuando se necesita buscar por clave y no recorrer. */
export function statusLabels(locale: Locale = "es-AR"): Record<CaseStatus, string> {
  return Object.fromEntries(
    statusOptions(locale).map((o) => [o.value, o.label])
  ) as Record<CaseStatus, string>;
}

/*
 * Acá vivía `claimTypeLabels`, el gemelo de `statusLabels`.
 *
 * Lo escribí por simetría al armar este módulo y no lo llamó nunca nadie. Un
 * export es una promesa —«esto lo usa alguien, cuidado al cambiarlo»— y una
 * promesa que nadie cobra sólo hace parecer que el módulo tiene una superficie
 * que no tiene. Si mañana hace falta, son cuatro líneas.
 */
