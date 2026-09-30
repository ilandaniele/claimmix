/**
 * Lo que el navegador necesita para pintar el vencimiento y la banda de
 * complejidad de un caso (B10, B13): cuentas puras, sin zod.
 *
 * Están aparte de `plazos.ts` y `puntaje-complejidad.ts` porque esos dos
 * traen los esquemas de zod, y un componente de cliente que los importara
 * subiría a todas las pantallas unos 18 kB comprimidos de zod que sólo usa el
 * servidor. Los dos módulos los reexportan, así que el resto del código sigue
 * importándolos de donde siempre.
 *
 * Es del equipo: no sale al asegurado, al prompt ni a las plantillas.
 */

export const DIA_MS = 86_400_000;

/** Cuántos días antes cuenta como «por vencer». */
export const DIAS_POR_VENCER = 5;

export type EstadoDelVencimiento = "vencido" | "por_vencer" | "en_plazo";

const enMs = (v: string | Date) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

export function estadoDelVencimiento(vence: string | Date | null, ahora: Date): EstadoDelVencimiento | null {
  if (vence === null) return null;
  const t = enMs(vence);
  if (Number.isNaN(t)) return null;
  const desde = ahora.getTime();
  if (t < desde) return "vencido";
  return t < desde + DIAS_POR_VENCER * DIA_MS ? "por_vencer" : "en_plazo";
}

/**
 * Cuántos días enteros faltan para el vencimiento: 0 es «vence hoy» (el plazo
 * corre hasta el último instante del día argentino) y -1 es «venció en las
 * últimas 24 horas». Sin fecha que sirva, null.
 */
export function diasAlVencimiento(vence: string | Date | null, ahora: Date): number | null {
  if (vence === null) return null;
  const t = enMs(vence);
  return Number.isNaN(t) ? null : Math.floor((t - ahora.getTime()) / DIA_MS);
}

export const RANGOS = {
  baja: { desde: 0, hasta: 33 },
  media: { desde: 34, hasta: 66 },
  alta: { desde: 67, hasta: 100 },
} as const;
export type BandaDeComplejidad = keyof typeof RANGOS;

export function bandaDe(puntaje: number | null): BandaDeComplejidad | null {
  if (puntaje === null) return null;
  if (puntaje <= RANGOS.baja.hasta) return "baja";
  return puntaje <= RANGOS.media.hasta ? "media" : "alta";
}
