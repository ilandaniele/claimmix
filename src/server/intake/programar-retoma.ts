/**
 * Encola la retoma de un caso que el worker difirió por una falla pasajera.
 *
 * El worker deja el caso marcado `extraction_pending` y suelta la reserva, pero
 * esa marca sólo la lee el barrido, que corre con el tráfico de otro caso o una
 * vez por día. `retomarTrasCorte` espera 45 s y lo retoma solo.
 *
 * Nunca tira: es un extra sobre la marca. Si el flujo no se puede encolar,
 * queda el comportamiento de antes —marca puesta y barrido— y no se pierde nada.
 */

import "server-only";

import { logger } from "@/lib/observability/logger";

export async function programarRetoma(caseId: string, tenantId: string): Promise<void> {
  try {
    // Dinámicos: el bundle de pasos del flujo arrastra `extract.ts` (ver `leerCartasDespues`).
    const [{ start }, { retomarTrasCorte }] = await Promise.all([
      import("workflow/api"),
      import("@/workflows/retomar-tras-corte"),
    ]);
    const run = await start(retomarTrasCorte, [{ caseId, tenantId }]);
    logger.info({ case_id: caseId, run_id: run.runId }, "retomar_pendientes.retoma_programada");
  } catch (e) {
    logger.warn(
      { case_id: caseId, error_name: e instanceof Error ? e.name : "UnknownError" },
      "retomar_pendientes.retoma_no_programada"
    );
  }
}
