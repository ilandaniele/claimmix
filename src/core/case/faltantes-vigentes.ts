/**
 * Qué filas de `missing_docs` siguen siendo un faltante de verdad al momento de leer.
 *
 * La tabla guarda lo que se pidió, no lo que falta hoy: el extractor emite
 * `dni` y `dni_asegurado` en el mismo mail y quedan dos filas por una sola
 * pregunta, y un dato que llegó en un mensaje posterior sigue "pendiente" hasta
 * que alguien lo confirme. Esto sólo filtra lo que se muestra o se le cuenta al
 * agente. No escribe nada: cerrar un faltante por inferencia está prohibido
 * (`documents.ts`), lo cierra una persona o una confirmación.
 *
 * Puro y sin `server-only`: lo importan pantallas de servidor y herramientas.
 */

import { clavesQueSatisfacen } from "@/core/case/required-fields";
import { estadoDelDocumento, type EstadoDelDocumento } from "@/core/case/estado-del-documento";
import { CLAVES_DE_DATO, canonicalFieldKey, clavesDelMismoCampo } from "@/lib/labels/claim-fields";

/** Desde acá un dato extraído cuenta como presente; es el mismo piso del analizador de huecos. */
export const CONFIANZA_DE_DATO_PRESENTE = 0.6;

const PRIORIDAD: Record<EstadoDelDocumento, number> = { received: 2, declined: 1, pending: 0 };

/** Todas las claves de campo extraído que dan por cerrada una fila con esta clave. */
export function clavesQueLoCierran(docKey: string): string[] {
  const alternativas = clavesQueSatisfacen(canonicalFieldKey(docKey)).flatMap(clavesDelMismoCampo);
  return [...new Set([...clavesDelMismoCampo(docKey), ...alternativas])];
}

export function faltantesVigentes<
  T extends { doc_key: string; satisfied_at?: Date | string | null; declined_at?: Date | string | null },
>(
  docs: readonly T[],
  campos: readonly { field_key: string; field_value: string | null; confidence: number | string | null }[],
  umbral = CONFIANZA_DE_DATO_PRESENTE
): T[] {
  // Una fila por clave canónica: la más avanzada, y a igualdad la primera (llegan por requested_at).
  const ganadoras = new Map<string, T>();
  for (const doc of docs) {
    const clave = canonicalFieldKey(doc.doc_key);
    const actual = ganadoras.get(clave);
    if (!actual || PRIORIDAD[estadoDelDocumento(doc)] > PRIORIDAD[estadoDelDocumento(actual)]) {
      ganadoras.set(clave, doc);
    }
  }
  const elegidas = new Set(ganadoras.values());

  const presentes = new Set<string>();
  for (const campo of campos) {
    if (campo.field_value?.trim() && Number(campo.confidence) >= umbral) presentes.add(campo.field_key);
  }

  return docs.filter((doc) => {
    if (!elegidas.has(doc)) return false;
    if (estadoDelDocumento(doc) !== "pending") return true;
    if (!CLAVES_DE_DATO.includes(canonicalFieldKey(doc.doc_key))) return true;
    return !clavesQueLoCierran(doc.doc_key).some((clave) => presentes.has(clave));
  });
}
