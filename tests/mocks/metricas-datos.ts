/**
 * Lo que `getTenantKpis` agregó (ciclo, cuellos, período, situación por día),
 * en cero, para los tests que arman un `MetricasData` a mano y sólo quieren
 * decidir los campos que les importan.
 */

import type { MetricasData } from "@/server/metrics/kpis";

export const RESUMEN_DEL_CICLO = {
  sin_intervencion_rate: null,
  mensajes_por_caso: null,
  ciclo: { mediana_horas_listo: null, casos_listo: 0, mediana_horas_cierre: null, casos_cierre: 0 },
  cuellos: [],
} satisfies Pick<
  MetricasData["summary"],
  "sin_intervencion_rate" | "mensajes_por_caso" | "ciclo" | "cuellos"
>;

export const PERIODO_DEL_MES = "este_mes" as const satisfies MetricasData["periodo"];

/** Los tres conteos de situación de un punto de la serie. */
export const SITUACION_EN_CERO = { escalados: 0, listos: 0, cerrados: 0 };
