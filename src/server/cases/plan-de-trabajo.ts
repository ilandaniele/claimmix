/**
 * Tildar o destildar a mano un paso del plan de trabajo de un caso (B11).
 *
 * Una sola sentencia: el paso que el actor puede tocar, el UPDATE si de verdad
 * cambia de estado, su auditoría con quién lo hizo y el conteo que dice si el
 * paso existía. El driver HTTP no deja leer, decidir y escribir, así que el
 * permiso sobre el caso va adentro del WHERE y no en una lectura previa.
 *
 * Marcar un paso que ya está como se pide (doble clic, dos pestañas, un
 * reintento) no lo toca: sigue diciendo quién lo hizo y cuándo, no deja una
 * auditoría de un cambio que no hubo y contesta igual que si hubiera pegado.
 *
 * Quien puede: todo el que asigna a terceros, o cualquier analista si el caso
 * está libre o es suyo —el mismo criterio que `puedeAsignar`—. Un paso que no
 * existe, un caso ajeno y un caso de otro inquilino (lo esconde la base) dan lo
 * mismo: cero filas.
 */

import "server-only";
import { sql } from "drizzle-orm";

import { enTenant, type TenantContext } from "@/data/scope";
import { AuditEvent } from "@/lib/audit/log";
import { asignaATerceros } from "@/lib/auth/roles";
import { conteoDe } from "@/lib/db/filas";
import { faltaLa0042 } from "@/server/core-sync/config";

export async function marcarPaso(
  ctx: TenantContext,
  caseId: string,
  clave: string,
  hecho: boolean,
  actor: { id: string; role: string }
): Promise<boolean> {
  const amplio = asignaATerceros(actor.role);
  const resultado = await enTenant(ctx, (db) =>
    db.execute(sql`
      WITH tocable AS (
        SELECT p.case_id, p.clave, p.hecho_en IS NOT NULL AS hecho
        FROM case_plan_pasos p
        WHERE p.case_id = ${caseId}::uuid AND p.clave = ${clave}::text
          AND EXISTS (
            SELECT 1 FROM cases c
            WHERE c.id = p.case_id
              AND (${amplio}::boolean OR c.assigned_to IS NULL OR c.assigned_to = ${actor.id}::uuid)
          )
      ),
      paso AS (
        UPDATE case_plan_pasos p
        SET hecho_en = CASE WHEN ${hecho}::boolean THEN now() END,
            hecho_por = CASE WHEN ${hecho}::boolean THEN ${actor.id}::uuid END,
            origen = 'manual'
        FROM tocable t
        WHERE p.case_id = t.case_id AND p.clave = t.clave
          AND t.hecho IS DISTINCT FROM ${hecho}::boolean
        RETURNING p.case_id, p.tenant_id, p.clave
      ),
      auditoria AS (
        INSERT INTO audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload)
        SELECT tenant_id, ${actor.id}::uuid, ${AuditEvent.CASE_PLAN_STEP}::text, 'case', case_id::text,
               jsonb_build_object('clave', clave, 'hecho', ${hecho}::boolean, 'origen', 'manual')
        FROM paso
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM tocable
    `)
  ).catch(faltaLa0042);
  return conteoDe(resultado) > 0;
}
