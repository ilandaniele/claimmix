/**
 * Los enlaces de /metricas: la unidad de la serie, el período y la vista viajan
 * en la URL, así que cambiar cualquiera es navegar y ninguno pisa a los otros.
 *
 * Puro: lo usan la pantalla y la serie de actividad.
 */

import { PERIODO_POR_DEFECTO, type Periodo } from "@/core/metricas/periodo";
import type { Unidad } from "@/core/metricas/serie";

export const VISTAS = ["tablero", "historial"] as const;
export type Vista = (typeof VISTAS)[number];

/** Lo que llega por `?vista=`; cualquier otra cosa es el tablero. */
export function vistaDe(valor: string | string[] | undefined): Vista {
  return VISTAS.find((v) => v === valor) ?? "tablero";
}

/** El período y la vista de siempre no se escriben: la URL de siempre sigue siendo la misma. */
export function hrefDeMetricas(p: { serie: Unidad; periodo: Periodo; vista?: Vista }): string {
  const q = new URLSearchParams({ serie: p.serie });
  if (p.periodo !== PERIODO_POR_DEFECTO) q.set("periodo", p.periodo);
  if (p.vista === "historial") q.set("vista", "historial");
  return `/metricas?${q}`;
}
