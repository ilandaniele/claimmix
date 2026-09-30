/**
 * Qué filas de auditoría cuentan el trayecto de un caso.
 *
 * El tablero (ciclo y cuellos de botella, B14) y la revisión nocturna (B22)
 * leen el recorrido de cada caso de `audit_log`. Esta lista es la que las dos
 * usan, y es EXACTAMENTE la del índice parcial `idx_audit_log_trayecto` de la
 * migración 0043: la consulta tiene que nombrar sólo eventos de la lista para
 * que Postgres pueda usar el índice, y el test de la migración compara las dos.
 */

import { EVENTOS_DE_INTERVENCION } from "@/core/metricas/intervencion";

/**
 * Los eventos cuyo payload dice a qué estado pasó el caso (`new_status`).
 *
 * `case.assigned` y `case.ready_confirmed` están porque un cambio de estado
 * con reasignación, o la confirmación de «listo», se guardan con ese nombre y
 * no como `case.status_changed`. `ai.extraction_complete` trae el estado
 * INTERMEDIO que deja la extracción (ver `status-after-extraction`): el `listo` de
 * ahí no es `listo_para_core`, y `EXTRACCION_INTERMEDIA` lo separa.
 */
export const EVENTOS_CON_ESTADO: readonly string[] = [
  "case.status_changed",
  "case.assigned",
  "case.closed",
  "case.ready_confirmed",
  "claim.case_reopened",
  "claim.closed_abandoned",
  "ai.extraction_complete",
  "ai.extracted",
  "core.sync_success",
  "core.sync_failed",
];

/** Lo que la derivación al equipo deja escrito aunque no cambie el estado. */
const EVENTOS_DE_DERIVACION: readonly string[] = ["claim.specialist_required", "claim.specialist_alerted"];

export const EVENTOS_DE_TRAYECTO: readonly string[] = [
  ...new Set([...EVENTOS_CON_ESTADO, ...EVENTOS_DE_INTERVENCION, ...EVENTOS_DE_DERIVACION]),
];

/** El `listo` que deja la extracción: lo pisa `listo_para_core` a los pocos milisegundos. */
export const EXTRACCION_INTERMEDIA = { evento: "ai.extraction_complete", estado: "listo" } as const;
