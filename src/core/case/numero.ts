/**
 * El número de caso que ve una persona: SIN-XXXX-XXXX a partir del UUID.
 *
 * Vivía copiado tres veces (`casos/[id]/page.tsx`, `clientes/[id]/page.tsx` y
 * `bandeja/components/casesRealtimeUtils.ts`), palabra por palabra. Único
 * lugar ahora porque el asistente (`herramientas.ts`) necesita la MISMA
 * cuenta al revés: de los 8 caracteres hex a las 8 últimas letras del UUID.
 */

/** UUID → "SIN-XXXX-XXXX", con los últimos 8 caracteres hex del id. */
export function formatCaseNumber(id: string): string {
  const suffix = id.replace(/-/g, "").slice(-8).toUpperCase();
  return `SIN-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}
