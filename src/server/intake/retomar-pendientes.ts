/**
 * El lector que le faltaba a `extraction_pending`.
 *
 * Cuatro caminos del worker marcan un caso «volvé por éste»:
 *
 *   · llegó un mensaje mientras corría (`acquireExtractionLease`);
 *   · el freno de simulación venció antes de tomar el turno;
 *   · la corrida se quedó sin reloj antes de llamar al modelo;
 *   · el redespacho no llegó.
 *
 * Y el único que lee esa marca es `releaseExtractionLease`, o sea el mismo
 * proceso que la escribió. Los comentarios de los tres caminos nuevos dicen «lo
 * toma la próxima corrida» — y esa próxima corrida sólo existe si la misma
 * persona vuelve a escribir. Si no escribe, el mensaje queda guardado y sin
 * leer para siempre.
 *
 * Peor: el ingreso no toca `cases.updated_at`, así que el reloj del abandono
 * sigue corriendo sobre la última vez que le hablamos NOSOTROS. A los catorce
 * días, `close-abandoned` lo cierra con «sin respuesta del denunciante» — y el
 * denunciante había contestado.
 *
 * ── Por qué no escala, como hace `reap-stuck` ───────────────────────────────
 *
 * Porque no es lo mismo. Un caso trabado en `procesando` es una corrida que
 * murió: escalarlo lo pone en la bandeja de una persona, que es lo que
 * corresponde. Un caso pendiente es trabajo que NADIE empezó todavía; lo que
 * corresponde es hacerlo, no delegarlo. Escalarlo llenaría el tablero de casos
 * que el sistema podía resolver solo.
 */

import "server-only";

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { cases } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";

/** Cuántos se retoman por corrida. El cron tiene 60 s y cada uno cuesta una extracción. */
const TOPE_POR_CORRIDA = 20;

/**
 * Cuánto se espera antes de retomar uno.
 *
 * La marca se pone y se limpia dentro de la misma invocación en el camino
 * normal —el redespacho la consume— así que retomar al instante pisaría corridas
 * vivas. Dos minutos es holgado contra una corrida que dura 10-20 s y corto
 * contra las catorce días que tarda el barrido de abandonados en cerrarlo.
 */
const ESPERA_MS = 2 * 60_000;

export interface RetomadosResult {
  retomados: number;
  caseIds: string[];
}

/**
 * Retoma los casos marcados como pendientes cuya reserva está libre o vencida.
 *
 * `runIntakeAgent` se importa en diferido: este módulo lo usa el cron y el
 * `after()` del webhook, y arrastrar el grafo del worker a los dos encarecería
 * el arranque en frío de rutas que muchas veces no retoman nada.
 */
export async function retomarExtraccionesPendientes(opts?: {
  tenantId?: string;
  limit?: number;
  leaseMs?: number;
}): Promise<RetomadosResult> {
  const limit = opts?.limit ?? TOPE_POR_CORRIDA;
  const corte = new Date(Date.now() - ESPERA_MS).toISOString();
  const leaseVencido = new Date(Date.now() - (opts?.leaseMs ?? 3 * 60_000)).toISOString();

  let pendientes: Array<{ id: string; tenant_id: string }>;
  try {
    // sin-inquilino: Barrido de sistema: recorre los casos de TODOS los inquilinos, que
    // es para lo que existe. El cron no corre en nombre de ninguno.
    pendientes = await db
      .select({ id: cases.id, tenant_id: cases.tenant_id })
      .from(cases)
      .where(
        and(
          eq(cases.extraction_pending, true),
          // Con la reserva tomada y fresca hay una corrida viva que va a
          // consumir la marca sola. Sólo se retoma lo que quedó huérfano.
          or(
            isNull(cases.extraction_lease_at),
            lt(cases.extraction_lease_at, leaseVencido)
          ),
          lt(cases.updated_at, corte),
          opts?.tenantId ? eq(cases.tenant_id, opts.tenantId) : undefined
        )
      )
      .limit(limit);
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "unknown";
    /*
     * Que el barrido roto no se vea igual que el barrido vacío.
     *
     * Es el error que el encabezado de `reap-stuck` describe haber cometido:
     * devolver cero y quedar en verde es peor que no tener red, porque el verde
     * convence. Acá el `catch` devuelve cero igual —no hay nada mejor que
     * devolver— pero lo dice.
     */
    logger.error({
        code,
      }, "retomar_pendientes.consulta_fallo");
    return { retomados: 0, caseIds: [] };
  }

  if (pendientes.length === 0) return { retomados: 0, caseIds: [] };

  const { runIntakeAgent } = await import("@/server/agents/intake-agent");
  const hechos: string[] = [];

  for (const caso of pendientes) {
    try {
      /*
       * De a uno y en serie, a propósito.
       *
       * Cada uno llama al modelo, y el freno de simulación ya serializa las
       * extracciones. Lanzarlos en paralelo haría que todos menos el primero
       * venzan el freno y se vuelvan a marcar pendientes — el mismo bucle que
       * este barrido viene a cerrar.
       */
      await runIntakeAgent({
        caseId: caso.id,
        tenantId: caso.tenant_id,
        source: "worker",
      });
      hechos.push(caso.id);
    } catch (e) {
      logger.error({
        case_id: caso.id,
        error_name: e instanceof Error ? e.name : "UnknownError",
      }, "retomar_pendientes.corrida_fallo");
    }
  }

  if (hechos.length > 0) {
    logger.info({
        retomados: hechos.length,
        de: pendientes.length,
      }, "retomar_pendientes.retomados");
  }

  return { retomados: hechos.length, caseIds: hechos };
}
