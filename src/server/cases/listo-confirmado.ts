/**
 * Cuándo un caso «listo para Core» quedó confirmado por una persona.
 *
 * `listo_para_core` lo escribe el agente solo. Que cuente en la métrica de
 * completitud automática requiere algo más: una fila de auditoría posterior a
 * la última corrida del agente sobre ese caso. Una corrida nueva —un mensaje
 * que llega, un reanálisis— invalida cualquier confirmación anterior: lo que
 * se confirmó ya no es necesariamente lo que el caso dice ahora.
 */

import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { agentRuns, auditLog, cases } from "@/lib/db/schema";
import { AuditEvent } from "@/lib/audit/log";

/** La última corrida del agente sobre el caso, o `-infinity` si nunca corrió. */
export function ultimaCorrida(caseId: SQL | string): SQL {
  return sql`coalesce((select max(${agentRuns.created_at}) from ${agentRuns} where ${agentRuns.case_id} = ${caseId}), '-infinity'::timestamptz)`;
}

/** Existe una confirmación de «listo» posterior a la última corrida del caso. */
export const listoConfirmado: SQL = sql`exists (
  select 1 from ${auditLog}
   where ${auditLog.target_type} = 'case'
     and ${auditLog.target_id} = ${cases.id}::text
     and ${auditLog.event_type} = ${AuditEvent.CASE_READY_CONFIRMED}
     and ${auditLog.created_at} > ${ultimaCorrida(sql`${cases.id}`)}
)`;

/**
 * Completado de verdad: ya salió a Core, o quedó listo y una persona lo
 * confirmó. El `listo` legado (el simulador viejo, sin persona de por medio)
 * no cuenta acá.
 */
export const completadoConfirmado: SQL = sql`(${cases.status} = 'enviado_a_core' or (${cases.status} = 'listo_para_core' and ${listoConfirmado}))`;
