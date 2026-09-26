/**
 * Cómo se lee un campo y su valor en el detalle del caso.
 *
 * `ExtractedFieldsTable`, `MissingDocsList` y `FieldConfirmationsPanel`
 * repetían cada una su propia versión de "clave a etiqueta" y mostraban el
 * valor crudo de la base (`true`, `none`, una fecha ISO). Este módulo es el
 * único lugar que decide las dos cosas, así las tres pantallas coinciden.
 * Cliente-safe: nada de imports de servidor.
 */

import { esAR, type TranslationKey } from "@/lib/i18n";
import { canonicalFieldKey, isNameable, labelForField } from "@/lib/labels/claim-fields";
import { valorLegible } from "@/core/mensajes/valor-legible";

type T = (k: TranslationKey) => string;

/** El nombre que lee una persona; nunca la clave cruda. */
export function etiquetaDeCampo(key: string, t: T): string {
  const canon = canonicalFieldKey(key);

  const campoKey = `field.${canon}` as TranslationKey;
  if (campoKey in esAR) return t(campoKey);

  const docKey = `docs.${canon}` as TranslationKey;
  if (docKey in esAR) return t(docKey);

  return labelForField(canon).label;
}

/** Si esta clave tiene una etiqueta pensada, en vez de sólo el título de la clave cruda. */
export function tieneEtiqueta(key: string): boolean {
  const canon = canonicalFieldKey(key);
  return (
    (`field.${canon}` as TranslationKey) in esAR ||
    (`docs.${canon}` as TranslationKey) in esAR ||
    isNameable(key)
  );
}

/** El valor como lo diría una persona: sí/no en vez de true/none, el tipo traducido. */
export function valorParaMostrar(key: string, valor: string, t: T, hoy: string): string {
  const canon = canonicalFieldKey(key);

  if (canon === "claim_type") {
    const tipoKey = `type.${valor}` as TranslationKey;
    if (tipoKey in esAR) return t(tipoKey);
  }

  const v = valorLegible(canon, valor, hoy);
  if (v === null) return valor;
  if (v === "sí") return t("common.yes");
  if (v === "no") return t("common.no");
  return v.charAt(0).toUpperCase() + v.slice(1);
}
