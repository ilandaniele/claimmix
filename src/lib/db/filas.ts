/**
 * Lo que devuelve `db.execute`, sin depender de qué driver lo armó.
 *
 * El driver entrega un objeto `{ rows }` y no un arreglo; el código que suponía
 * un arreglo recibía una lista vacía, y en `/api/health` eso marcó como
 * faltantes migraciones que estaban todas aplicadas. Vive en un módulo sin
 * imports para que lo usen la salud y las sentencias de escritura por igual.
 */

/** Las filas del resultado crudo, sea arreglo o `{ rows }`; vacío si no hay nada que leer. */
export function filasDe<T = Record<string, unknown>>(resultado: unknown): T[] {
  if (Array.isArray(resultado)) return resultado as T[];
  const filas = (resultado as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(filas) ? (filas as T[]) : [];
}

/** El `n` de la primera fila —lo que devuelve `SELECT count(*)::int AS n`—; 0 si falta o no es un número. */
export function conteoDe(resultado: unknown): number {
  const n = Number(filasDe<{ n?: number | string }>(resultado)[0]?.n ?? 0);
  return Number.isFinite(n) ? n : 0;
}
