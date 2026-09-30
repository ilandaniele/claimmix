/**
 * El estado de una fila de `missing_docs`, tal como lo lee un analista.
 *
 * Módulo aparte porque lo importa `MissingDocsList.tsx` (`"use client"`): en
 * `required-docs.ts` arrastraba al navegador los documentos de todos los ramos.
 * Tampoco puede vivir en el componente: uno de servidor no puede llamar a una
 * función exportada por un módulo de cliente.
 */

export type EstadoDelDocumento = "received" | "declined" | "pending";

export function estadoDelDocumento(d: {
  satisfied_at?: unknown;
  declined_at?: unknown;
}): EstadoDelDocumento {
  if (d.satisfied_at) return "received";
  // Antes de "pending": el asegurado avisó que no tiene este documento, y un
  // analista que lee "pendiente" sale a buscar un papel que nadie tiene.
  if (d.declined_at) return "declined";
  return "pending";
}
