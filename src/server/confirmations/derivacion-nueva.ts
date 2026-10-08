/**
 * Anotar la derivación de un caso, una sola vez por episodio.
 *
 * Va en un módulo propio para que los tests del orquestador puedan simularla
 * sin armar el batch.
 */

import "server-only";
import { sql } from "drizzle-orm";
import { enTenantVarias } from "@/data/scope";
import { AuditEvent } from "@/lib/audit/log";
import { auditoriaSiEsDerivacionNueva } from "@/server/cases/auditoria-si-quedo";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";

/**
 * Deja `claim.specialist_required` si el caso todavía no tiene uno de este
 * episodio, y dice si lo dejó. Quien llama manda el mensaje al asegurado sólo
 * si devuelve `true`: una derivación, un evento, un mensaje.
 *
 * El lote HTTP de Neon es una sola transacción en READ COMMITTED, y un
 * `INSERT ... SELECT ... NOT EXISTS` solo no alcanza: dos derivaciones a la vez
 * verían las dos «no existe». Por eso lo primero del lote es un lock de
 * transacción por caso. La segunda espera, y su INSERT toma la foto DESPUÉS de
 * obtener el lock, así que ve la fila que la primera ya confirmó. Se suelta
 * solo al terminar el lote; no pide permiso de UPDATE ni frena a `setStatus`.
 *
 * Si la guarda se cae devuelve `true`, que es lo que pasaba antes de ella:
 * mejor un mensaje de más que un asegurado sin aviso.
 */
export async function anotarDerivacionSiEsNueva(o: {
  tenantId: string;
  caseId: string;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const res = await enTenantVarias({ tenantId: o.tenantId }, (db) => [
      db.execute(sql`select pg_advisory_xact_lock(hashtext('derivacion'), hashtext(${o.caseId}::text))`),
      auditoriaSiEsDerivacionNueva(db, {
        caseId: o.caseId,
        actorId: null,
        eventType: AuditEvent.SPECIALIST_REQUIRED,
        payload: sql<Record<string, unknown>>`${JSON.stringify(o.payload)}::jsonb`,
      }),
    ]);
    return (res[1] as unknown[]).length > 0;
  } catch (err) {
    logger.error({ code: errorCode(err), case_id: o.caseId }, "escalation.audit_guard_failed");
    return true;
  }
}
