/**
 * La retención de casos (B19): borra los casos cerrados hace más de N años
 * (`RETENCION_ANIOS`, cinco por omisión).
 *
 * Cuelga del cron `reap-stuck`, dentro de la ventana diaria. Nace APAGADA
 * (`RETENCION_MODO`): `simular` sólo cuenta, `borrar` borra. Un valor que no se
 * entiende también apaga: borrar es lo que no se hace por error.
 *
 * Alcance, a propósito corto: sólo CASOS en un estado cerrado (`cerrado`,
 * `pagado`, `rechazado`) con `closed_at` anterior al corte. No toca clientes ni
 * pólizas —el padrón es de la aseguradora y sobrevive a sus casos—, ni la
 * auditoría, ni los casos `no_relevante`, que no son un siniestro cerrado.
 *
 * Borra por `deleteCases`, que es el mismo camino que el borrado de una persona:
 * en el mismo lote anota los adjuntos de R2 para la purga diferida, y el DELETE
 * vuelve a comprobar el estado y `closed_at`. Un caso que se reabrió (P8) entre
 * que se lo listó acá y el DELETE deja de coincidir y no se borra.
 *
 * Por inquilino y con tope: lo que hoy no entra, entra mañana. Un inquilino que
 * falla se registra y no frena a los demás.
 */

import "server-only";

import { asc } from "drizzle-orm";

import { leerRetencion, type ModoDeBorrado } from "@/core/retencion";
import { enTenant, type TenantContext } from "@/data/scope";
import { db } from "@/lib/db";
import { cases, tenants } from "@/lib/db/schema";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { cerradoAntesDe, deleteCases } from "@/server/cases/delete";

/** Cuántos casos por inquilino y por corrida. */
export const POR_INQUILINO = 200;

export type ResultadoRetencion = {
  modo: ModoDeBorrado;
  anios: number;
  /** El corte, en ISO: se borra lo cerrado ANTES de esta fecha. */
  corte: string;
  inquilinos: number;
  /** Casos que entraban en el corte (con el tope por inquilino). */
  candidatos: number;
  borrados: number;
};

/** Los casos cerrados antes del corte de un inquilino, los más viejos primero. */
async function vencidos(ctx: TenantContext, corte: Date): Promise<string[]> {
  const filas = await enTenant<Array<{ id: string }>>(ctx, (t) =>
    t
      .select({ id: cases.id })
      .from(cases)
      .where(cerradoAntesDe(corte))
      .orderBy(asc(cases.closed_at))
      .limit(POR_INQUILINO)
  );
  return filas.map((f) => f.id);
}

/**
 * Aplica la retención hasta `hasta` (milisegundos de reloj), con el reloj `ahora`.
 *
 * @returns `null` si la retención está apagada, sin haber tocado la base.
 */
export async function aplicarRetencion(
  { hasta }: { hasta: number },
  ahora: Date = new Date()
): Promise<ResultadoRetencion | null> {
  const { modo, anios, corte } = leerRetencion(process.env, ahora);
  if (modo === "apagado") return null;

  // sin-inquilino: Barrido de sistema: recorre TODOS los inquilinos, que es para lo
  // que existe. Lo que se lee y se borra de cada uno va por la capa, con su contexto.
  const inquilinos = await db.select({ id: tenants.id }).from(tenants).orderBy(asc(tenants.id));

  const resultado: ResultadoRetencion = {
    modo,
    anios,
    corte: corte.toISOString(),
    inquilinos: inquilinos.length,
    candidatos: 0,
    borrados: 0,
  };

  for (const { id: tenantId } of inquilinos) {
    if (Date.now() >= hasta) break;

    try {
      const ctx: TenantContext = { tenantId };
      const ids = await vencidos(ctx, corte);
      resultado.candidatos += ids.length;
      if (modo === "simular" || ids.length === 0) continue;

      const borrados = await deleteCases(ctx, ids, { id: null, role: "retencion" }, { antesDe: corte });
      resultado.borrados += borrados.length;

      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: null,
        event_type: AuditEvent.RETENCION_APLICADA,
        target_type: "tenant",
        target_id: tenantId,
        payload: { anios, corte: resultado.corte, candidatos: ids.length, borrados: borrados.length },
      });
    } catch (err) {
      logger.error({ code: errorCode(err) }, "retencion.inquilino_fallo");
    }
  }

  if (modo === "simular") {
    logger.info(
      { anios, inquilinos: resultado.inquilinos, candidatos: resultado.candidatos },
      "retencion.simulada"
    );
  }
  return resultado;
}
